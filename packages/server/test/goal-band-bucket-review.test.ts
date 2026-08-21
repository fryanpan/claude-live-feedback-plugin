/**
 * A new goal band asks the bucket to be re-looked-at.
 *
 * The unknown-goal bucket (`unplacedSince`) is fine sitting at lowest
 * priority, but a task in it should get attached to a goal later "if a goal
 * becomes apparent". The most literal reading of that is a new BAND appearing
 * in the goal list — and before this file, that fired nothing. Measured on
 * this tree before the change, with the store's real delivery bridge:
 *
 *   set_goal_list adding a band → 0 requests
 *   reorder_goals               → 0 requests
 *   set_workspace_goal (control)→ 1 request, covering both bucket tasks
 *
 * The positive control is load-bearing and it is asserted FIRST here: a
 * harness that cannot observe a delivery it SHOULD see proves nothing by
 * failing to observe one it should not.
 *
 * Why its own slot rather than the existing queued-retriage sidecar. That
 * one's `oldGoal`/`newGoal` are the north-star TEXT, which a goal-list edit
 * does not touch, and the drain path renders them to the agent as "what your
 * placements were last judged against". Reusing the slot would make both
 * fields lie. This request carries its own baseline — the goal LIST before
 * and after — in its own sidecar, with the same live-or-queue durability.
 *
 * And it never PLACES anything: it asks the lead to look. Auto-assigning
 * would stamp a ranking decision no human made, invisibly.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHORES_GOAL_ID,
  type PendingBucketReview,
  TaskStore,
  type TriageRequest,
  pendingBucketReviewPath,
  pendingRetriagePath,
} from '../src/tasks.ts';
import type { GoalIds } from './goal-seed.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = 'agent-lead';
const OTHER = 'agent-bystander';

describe('a new goal band asks the bucket to be re-looked-at', () => {
  let dataDir: string;
  let store: TaskStore;
  let requests: TriageRequest[];

  const wire = (s: TaskStore) => {
    // The REAL bridge shape (server.ts installs the same rule): a request
    // that is ADDRESSED to the lead counts as delivered only when the lead is
    // live. Anything looser and every "queued" case below tests the test.
    s.setTriageDelivery((req) => {
      if (req.kind !== 'task' && !s.hasLiveLeadAttachment(req.workspaceId)) return false;
      requests.push(req);
      return true;
    });
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'band-bucket-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    requests = [];
    wire(store);
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A board with a live lead and two tasks nobody named a goal for. */
  const board = (opts: { lead?: string | null } = {}) => {
    const leadId = opts.lead === null ? undefined : (opts.lead ?? LEAD);
    const ws = store.createWorkspace(
      'review surface',
      'Old north star.',
      leadId ? { leadAgentId: leadId } : undefined,
    );
    if (leadId) store.attachAgent(ws.id, { agentId: leadId, runtime: 'claude-code-local' });
    const a = store.createTask(ws.id, { title: 'figure out og-images' });
    const b = store.createTask(ws.id, { title: 'audit the empty states' });
    if (!a.ok || !b.ok) throw new Error('fixture');
    requests.length = 0;
    return { ws, ids: [a.task.id, b.task.id] };
  };

  /**
   * Submit a goal list now that ids are GENERATED. A spec entry whose key is
   * already in `ids` is KEPT — its minted id is sent back, which is the only
   * spelling the store accepts — and a key that is not is NEW, so the server
   * mints one and it joins the map this returns. Tests keep saying "g1"/"g2"
   * while never naming an id the board would refuse (`unknown-goal-id`).
   */
  type BandSpec = { key: string; title: string; subgoals?: BandSpec[] };
  /** What goes on the wire: an id only when the band already exists. */
  type BandEntry = { id?: string; title: string; subgoals?: BandEntry[] };

  const submit = (
    wsId: string,
    spec: BandSpec[],
    ids: GoalIds = {},
    opts: { actor?: { id: string; name: string; kind?: string }; drop?: string[] } = {},
  ) => {
    const entry = (g: BandSpec): BandEntry => ({
      ...(ids[g.key] !== undefined ? { id: ids[g.key] } : {}),
      title: g.title,
      ...(g.subgoals !== undefined ? { subgoals: g.subgoals.map(entry) } : {}),
    });
    const res = store.setGoalList(
      wsId,
      spec.map(entry) as Parameters<TaskStore['setGoalList']>[1],
      { actor: opts.actor ?? PERSON, ...(opts.drop !== undefined ? { drop: opts.drop } : {}) },
    );
    // Throw on refusal, for the reason goal-seed.ts gives: a seed that
    // silently did nothing leaves the "emits nothing" cases below asserting
    // an absence over an empty board, which they would pass for the wrong
    // reason. Every submit in this file is expected to succeed.
    if (!res.ok) throw new Error(`submit: setGoalList refused with ${res.error}`);
    const next: GoalIds = { ...ids };
    if (res.ok) {
      // Same order `created` reports: each entry, then its subgoals.
      const fresh: string[] = [];
      for (const g of spec) {
        if (ids[g.key] === undefined) fresh.push(g.key);
        for (const sub of g.subgoals ?? []) if (ids[sub.key] === undefined) fresh.push(sub.key);
      }
      if (fresh.length !== res.created.length) {
        throw new Error(`submit: ${fresh.length} new keys but ${res.created.length} created`);
      }
      fresh.forEach((key, i) => {
        next[key] = (res.created[i] as { id: string }).id;
      });
    }
    return { res, ids: next };
  };

  const bucketReviews = () => requests.filter((r) => r.kind === 'bucket-review');

  describe('the harness can see a delivery (positive control)', () => {
    it('a north-star edit still reaches the live lead — 1 request, both bucket tasks', () => {
      const { ws, ids } = board();
      const res = store.setWorkspaceGoal(ws.id, 'A different north star.', { actor: PERSON });
      expect(res.ok).toBe(true);
      const retriages = requests.filter((r) => r.kind === 'goal-retriage');
      expect(retriages.length).toBe(1);
      const first = retriages[0];
      if (first?.kind !== 'goal-retriage') throw new Error('unreachable');
      expect(first.taskIds.sort()).toEqual([...ids].sort());
    });
  });

  describe('the trigger', () => {
    it('adding a band emits a request naming the unplaced ids and the band that appeared', () => {
      const { ws, ids } = board();
      const { res, ids: G } = submit(ws.id, [{ key: 'g1', title: 'Ship the review surface' }]);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const reviews = bucketReviews();
      expect(reviews.length).toBe(1);
      const req = reviews[0];
      if (req?.kind !== 'bucket-review') throw new Error('unreachable');
      expect(req.taskIds.sort()).toEqual([...ids].sort());
      expect(req.newBands).toEqual([{ id: G.g1, title: 'Ship the review surface' }]);
      // Its own baseline: the goal LIST before and after, not the north star.
      expect(req.oldGoals).toEqual([]);
      expect(req.newGoals.map((g) => g.id)).toEqual([G.g1]);
      expect(req.leadAgentId).toBe(LEAD);
      // The caller gets the same answer the north-star path gives.
      expect(res.bucketReview.requested).toBe(true);
      expect(res.bucketReview.queued).toBe(false);
      expect(res.bucketReview.taskIds.sort()).toEqual([...ids].sort());
    });

    it('a new SUBGOAL is a new band too — it is a destination a task can be placed on', () => {
      const { ws } = board();
      const { ids: G0 } = submit(ws.id, [{ key: 'g1', title: 'Ship it' }]);
      requests.length = 0;
      const { ids: G } = submit(
        ws.id,
        [{ key: 'g1', title: 'Ship it', subgoals: [{ key: 'g1a', title: 'Mobile pass' }] }],
        G0,
      );
      const req = bucketReviews()[0];
      if (req?.kind !== 'bucket-review') throw new Error('expected a bucket review');
      expect(req.newBands).toEqual([{ id: G.g1a, title: 'Mobile pass' }]);
    });

    it('a task swept to Backlog by the same edit is in the bucket it asks about', () => {
      const ws = store.createWorkspace('board', 'North star.', { leadAgentId: LEAD });
      store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      const { ids: G } = submit(ws.id, [{ key: 'old', title: 'Old band' }]);
      const t = store.createTask(ws.id, { title: 'ported from the old band', goal: G.old });
      if (!t.ok) throw new Error('fixture');
      requests.length = 0;
      // Replace the band: the open task is swept to Backlog AND a band appears.
      submit(ws.id, [{ key: 'new', title: 'New band' }], {}, { drop: [G.old as string] });
      const req = bucketReviews()[0];
      if (req?.kind !== 'bucket-review') throw new Error('expected a bucket review');
      expect(req.taskIds).toEqual([t.task.id]);
    });

    it('never places anything — the bucket tasks are untouched', () => {
      const { ws, ids } = board();
      submit(ws.id, [{ key: 'g1', title: 'Ship it' }]);
      for (const id of ids) {
        const task = store.getTask(id);
        expect(task?.goal).toBe(CHORES_GOAL_ID);
        expect(task?.unplacedSince).toBeGreaterThan(0);
      }
    });
  });

  describe('what reveals no new band emits nothing', () => {
    const twoBands = () => {
      const b = board();
      const { ids } = submit(b.ws.id, [
        { key: 'g1', title: 'One' },
        { key: 'g2', title: 'Two' },
      ]);
      requests.length = 0;
      return { ...b, G: ids };
    };

    it('reorder_goals emits nothing', () => {
      const { ws, G } = twoBands();
      const res = store.reorderGoals(ws.id, [G.g2 as string, G.g1 as string], { actor: PERSON });
      expect(res.ok).toBe(true);
      expect(requests.length).toBe(0);
      expect(existsSync(pendingBucketReviewPath(dataDir, ws.id))).toBe(false);
    });

    it('a reorder submitted through set_goal_list emits nothing', () => {
      const { ws, G } = twoBands();
      const { res } = submit(
        ws.id,
        [
          { key: 'g2', title: 'Two' },
          { key: 'g1', title: 'One' },
        ],
        G,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(bucketReviews().length).toBe(0);
      expect(res.bucketReview.requested).toBe(false);
      expect(res.bucketReview.queued).toBe(false);
    });

    it('a retitle in place emits nothing — same ids, no new destination', () => {
      const { ws, G } = twoBands();
      submit(
        ws.id,
        [
          { key: 'g1', title: 'One, reworded' },
          { key: 'g2', title: 'Two' },
        ],
        G,
      );
      expect(bucketReviews().length).toBe(0);
    });

    it('rename_goal emits nothing', () => {
      const { ws, G } = twoBands();
      store.renameGoal(ws.id, G.g1 as string, { title: 'One, renamed' }, { actor: PERSON });
      expect(bucketReviews().length).toBe(0);
    });

    it('a band appearing over an EMPTY bucket emits nothing', () => {
      const ws = store.createWorkspace('board', 'North star.', { leadAgentId: LEAD });
      store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      store.createTask(ws.id, { title: 'a deliberate chore', goal: 'chores' });
      requests.length = 0;
      const { res } = submit(ws.id, [{ key: 'g1', title: 'Ship it' }]);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(requests.length).toBe(0);
      expect(res.bucketReview.taskIds).toEqual([]);
    });
  });

  describe('durability — its own slot, replayed on the lead’s next attach', () => {
    it('an undelivered request persists to its OWN sidecar and leaves the retriage one alone', () => {
      const { ws, ids } = board({ lead: null });
      const { res, ids: G } = submit(ws.id, [{ key: 'g1', title: 'Ship it' }]);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.bucketReview.requested).toBe(false);
      expect(res.bucketReview.queued).toBe(true);
      expect(existsSync(pendingBucketReviewPath(dataDir, ws.id))).toBe(true);
      expect(existsSync(pendingRetriagePath(dataDir, ws.id))).toBe(false);

      const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      expect(attach.ok).toBe(true);
      if (!attach.ok) return;
      const pending = attach.pendingBucketReview as PendingBucketReview | undefined;
      expect(pending?.taskIds.sort()).toEqual([...ids].sort());
      expect(pending?.newBands).toEqual([{ id: G.g1, title: 'Ship it' }]);
      expect(pending?.oldGoals).toEqual([]);
      // Drained by that call — a second attach is offered nothing.
      const again = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      expect(again.ok && again.pendingBucketReview).toBeUndefined();
      expect(existsSync(pendingBucketReviewPath(dataDir, ws.id))).toBe(false);
    });

    it('a queued north-star retriage and a queued bucket review both survive, separately', () => {
      const { ws } = board({ lead: null });
      store.setWorkspaceGoal(ws.id, 'A different north star.', { actor: PERSON });
      const { ids: G } = submit(ws.id, [{ key: 'g1', title: 'Ship it' }]);
      expect(existsSync(pendingRetriagePath(dataDir, ws.id))).toBe(true);
      expect(existsSync(pendingBucketReviewPath(dataDir, ws.id))).toBe(true);
      const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      if (!attach.ok) throw new Error('attach failed');
      // The north-star ask keeps its own TEXT baseline; the band ask keeps
      // the goal LIST. Neither field describes the other's edit.
      expect(attach.pendingRetriage?.oldGoal).toBe('Old north star.');
      expect(attach.pendingBucketReview?.newBands).toEqual([{ id: G.g1, title: 'Ship it' }]);
    });

    it('a non-lead attach leaves it waiting', () => {
      const { ws } = board({ lead: null });
      submit(ws.id, [{ key: 'g1', title: 'Ship it' }]);
      // Seat the lead explicitly so the bystander cannot claim an empty seat.
      // LEAD has no attachment record yet, so it must SELF-declare — the one
      // form the unknown-id guard exempts (declare-then-attach bootstrap).
      const seat = store.setLeadAgent(ws.id, LEAD, { actor: { id: LEAD, name: LEAD } });
      if (!seat.ok) throw new Error('fixture: declaration refused');
      const bystander = store.attachAgent(ws.id, { agentId: OTHER, runtime: 'claude-code-local' });
      expect(bystander.ok && bystander.pendingBucketReview).toBeUndefined();
      expect(existsSync(pendingBucketReviewPath(dataDir, ws.id))).toBe(true);
    });

    it('survives a restart', () => {
      const { ws, ids } = board({ lead: null });
      submit(ws.id, [{ key: 'g1', title: 'Ship it' }]);
      store.stop();

      const revived = new TaskStore({ dataDir, debounceMs: 5 });
      wire(revived);
      try {
        const attach = revived.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
        if (!attach.ok) throw new Error('attach failed');
        expect(attach.pendingBucketReview?.taskIds.sort()).toEqual([...ids].sort());
      } finally {
        revived.stop();
        store = revived;
      }
    });

    it('a lead handover re-asks the new occupant while they are live', () => {
      const { ws } = board({ lead: null });
      submit(ws.id, [{ key: 'g1', title: 'Ship it' }]);
      store.attachAgent(ws.id, { agentId: OTHER, runtime: 'claude-code-local' });
      requests.length = 0;
      // OTHER claimed the empty seat by attaching; the seat moves to LEAD,
      // who is NOT live — nothing goes out, the request keeps waiting. LEAD
      // has no attachment record, so it SELF-declares (the unknown-id guard
      // exempts that), with takeover because OTHER is live in the seat.
      const seat = store.setLeadAgent(ws.id, LEAD, {
        actor: { id: LEAD, name: LEAD },
        takeover: true,
      });
      if (!seat.ok) throw new Error('fixture: declaration refused');
      expect(bucketReviews().length).toBe(0);
      // Now LEAD is live and the seat moves to them: it goes out.
      store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      const drained = store.attachAgent(ws.id, { agentId: OTHER, runtime: 'claude-code-local' });
      expect(drained.ok && drained.pendingBucketReview).toBeUndefined();
    });

    it('two edits in one gap coalesce: first baseline, newest list, unions', () => {
      const { ws, ids } = board({ lead: null });
      const { ids: G0 } = submit(ws.id, [{ key: 'g1', title: 'One' }]);
      const third = store.createTask(ws.id, { title: 'arrived between the two edits' });
      if (!third.ok) throw new Error('fixture');
      const { ids: G } = submit(
        ws.id,
        [
          { key: 'g1', title: 'One' },
          { key: 'g2', title: 'Two' },
        ],
        G0,
      );
      const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      if (!attach.ok) throw new Error('attach failed');
      const pending = attach.pendingBucketReview;
      expect(pending?.oldGoals).toEqual([]);
      expect(pending?.newGoals.map((g) => g.id)).toEqual([G.g1, G.g2]);
      expect(pending?.newBands.map((b) => b.id).sort()).toEqual([G.g1, G.g2].sort());
      expect(pending?.taskIds.sort()).toEqual([...ids, third.task.id].sort());
    });
  });

  describe('the replay describes the board as it stands NOW', () => {
    it('a task placed since is dropped from the waiting request', () => {
      const { ws, ids } = board({ lead: null });
      const { ids: G } = submit(ws.id, [{ key: 'g1', title: 'Ship it' }]);
      const [first, second] = ids;
      if (!first || !second) throw new Error('fixture');
      store.setTaskGoal(first, G.g1 as string, { actor: PERSON });
      const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      if (!attach.ok) throw new Error('attach failed');
      expect(attach.pendingBucketReview?.taskIds).toEqual([second]);
    });

    it('a request whose whole bucket got placed retires itself', () => {
      const { ws, ids } = board({ lead: null });
      const { ids: G } = submit(ws.id, [{ key: 'g1', title: 'Ship it' }]);
      for (const id of ids) store.setTaskGoal(id, G.g1 as string, { actor: PERSON });
      const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      expect(attach.ok && attach.pendingBucketReview).toBeUndefined();
      expect(existsSync(pendingBucketReviewPath(dataDir, ws.id))).toBe(false);
    });

    it('a band removed since is dropped, and a request with no bands left retires', () => {
      const { ws } = board({ lead: null });
      const { ids: G } = submit(ws.id, [
        { key: 'g1', title: 'One' },
        { key: 'g2', title: 'Two' },
      ]);
      submit(ws.id, [{ key: 'g1', title: 'One' }], G);
      const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      if (!attach.ok) throw new Error('attach failed');
      expect(attach.pendingBucketReview?.newBands.map((b) => b.id)).toEqual([G.g1]);

      // And when EVERY band that appeared has since gone, the ask retires
      // rather than naming a band that no longer exists.
      const { ws: ws2 } = board({ lead: null });
      const { ids: GX } = submit(ws2.id, [{ key: 'gx', title: 'Temporary' }]);
      submit(ws2.id, [], GX, { drop: [GX.gx as string] });
      const attach2 = store.attachAgent(ws2.id, { agentId: LEAD, runtime: 'claude-code-local' });
      expect(attach2.ok && attach2.pendingBucketReview).toBeUndefined();
      expect(existsSync(pendingBucketReviewPath(dataDir, ws2.id))).toBe(false);
    });

    // A retitle deliberately asks for nothing (it reveals no new destination),
    // which means it also never refreshes a waiting ask. So a band added while
    // the lead was away and renamed before they got back would replay under
    // the title it had at capture — naming a band the board no longer calls
    // that, in a request whose whole job is to say which band appeared.
    it('names a renamed band the way the board names it NOW', () => {
      const { ws } = board({ lead: null });
      const { ids: G } = submit(ws.id, [{ key: 'g1', title: 'Provisional name' }]);
      store.renameGoal(ws.id, G.g1 as string, { title: 'Reviewer trust' }, { actor: PERSON });
      const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      if (!attach.ok) throw new Error('attach failed');
      expect(attach.pendingBucketReview?.newBands).toEqual([{ id: G.g1, title: 'Reviewer trust' }]);
    });

    // The control above this one used to be "add a band, don't rename it, see
    // the title survive" — which passes whether the title came from the record
    // or from the live list, because with no rename the two are identical. It
    // established nothing about WHICH list was read. This does: two bands
    // appear together and only one is renamed, so replaying from the record
    // gets the first wrong and rebuilding blindly (or dropping the untouched
    // band) gets the second wrong. Only reading the live list per id passes.
    it('refreshes the renamed band and leaves its untouched sibling alone', () => {
      const { ws } = board({ lead: null });
      const { ids: G } = submit(ws.id, [
        { key: 'g1', title: 'Provisional name' },
        { key: 'g2', title: 'Reviewer trust' },
      ]);
      store.renameGoal(ws.id, G.g1 as string, { title: 'Mobile review' }, { actor: PERSON });
      const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      if (!attach.ok) throw new Error('attach failed');
      expect(attach.pendingBucketReview?.newBands).toEqual([
        { id: G.g1, title: 'Mobile review' },
        { id: G.g2, title: 'Reviewer trust' },
      ]);
    });
  });

  // The record's stored ids are its provenance; the bucket is re-read live.
  // Intersecting against the snapshot could only ever SHRINK, which drops a
  // task filed after the edit out of the one ask it belongs in — while the
  // same attach response lists it under `untriaged`, which is how the gap
  // would have presented: two fields on one response disagreeing.
  describe('the bucket is read as it stands now, in both directions', () => {
    it('includes a task filed AFTER the band appeared', () => {
      const { ws, ids } = board({ lead: null });
      submit(ws.id, [{ key: 'g1', title: 'Ship it' }]);
      const later = store.createTask(ws.id, { title: 'check the print stylesheet' });
      if (!later.ok) throw new Error('fixture');
      const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      if (!attach.ok) throw new Error('attach failed');
      expect(attach.pendingBucketReview?.taskIds.sort()).toEqual([...ids, later.task.id].sort());
      // And it agrees with the other half of the same response.
      expect(attach.pendingBucketReview?.taskIds.sort()).toEqual([...attach.untriaged].sort());
    });

    // The case a LENGTH compare cannot see, and the reason the guard compares
    // values: one task leaves the bucket and another joins it, so the count is
    // unchanged and the set is completely different. A count-only guard
    // decides nothing needs re-persisting and hands back the stale ids —
    // naming a task already placed and omitting the one that still needs a
    // home, which is both halves of the mistake at once.
    it('one task placed and another filed in the same gap keeps no stale id', () => {
      const { ws, ids } = board({ lead: null });
      const { ids: G } = submit(ws.id, [{ key: 'g1', title: 'Ship it' }]);
      const [first, second] = ids;
      if (!first || !second) throw new Error('fixture');
      store.setTaskGoal(first, G.g1 as string, { actor: PERSON });
      const later = store.createTask(ws.id, { title: 'check the print stylesheet' });
      if (!later.ok) throw new Error('fixture');

      const got = store.getPendingBucketReview(ws.id);
      expect(got?.taskIds.length).toBe(2); // same COUNT as when it was queued
      expect(got?.taskIds.slice().sort()).toEqual([second, later.task.id].sort());
      // And the refresh was persisted, not just computed for this caller.
      const onDisk = JSON.parse(readFileSync(pendingBucketReviewPath(dataDir, ws.id), 'utf8')) as {
        pending: PendingBucketReview;
      };
      expect(onDisk.pending.taskIds.slice().sort()).toEqual([second, later.task.id].sort());
    });

    it('still drops a task placed since, so the ask is never work already done', () => {
      const { ws, ids } = board({ lead: null });
      const { ids: G } = submit(ws.id, [{ key: 'g1', title: 'Ship it' }]);
      const [first, second] = ids;
      if (!first || !second) throw new Error('fixture');
      store.setTaskGoal(first, G.g1 as string, { actor: PERSON });
      const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      if (!attach.ok) throw new Error('attach failed');
      expect(attach.pendingBucketReview?.taskIds).toEqual([second]);
    });
  });

  describe('a coalesced record is described honestly', () => {
    it('the second ack reports the bands actually waiting, not just its own', () => {
      const { ws } = board({ lead: null });
      const { ids: G0 } = submit(ws.id, [{ key: 'g1', title: 'One' }]);
      const { res: second, ids: G } = submit(
        ws.id,
        [
          { key: 'g1', title: 'One' },
          { key: 'g2', title: 'Two' },
        ],
        G0,
      );
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.bucketReview.queued).toBe(true);
      // `queued: true` and `newBands` have to be about the same object: the
      // lead will be handed both bands, so an ack naming only g2 describes
      // something narrower than what is on disk.
      expect(second.bucketReview.newBands.map((b) => b.id).sort()).toEqual([G.g1, G.g2].sort());
    });

    it('keeps time and actor from the same (first) edit', () => {
      const { ws } = board({ lead: null });
      const other = { id: 'known-sam', name: 'Sam', kind: 'person' };
      const { ids: G0 } = submit(ws.id, [{ key: 'g1', title: 'One' }]);
      const before = store.getPendingBucketReview(ws.id);
      const firstTs = before?.ts;
      submit(
        ws.id,
        [
          { key: 'g1', title: 'One' },
          { key: 'g2', title: 'Two' },
        ],
        G0,
        { actor: other },
      );
      const merged = store.getPendingBucketReview(ws.id);
      // Taking the clock from one edit and the person from another produces a
      // pair that reads as "this person did this then" and is true of nobody
      // — the shape a strip renders as "Edited by <name>" beside a time.
      expect(merged?.ts).toBe(firstTs as number);
      expect(merged?.actor.id).toBe(PERSON.id);
    });
  });

  // A sidecar missing a field the TYPE says is required loads as `undefined`
  // and goes straight back onto the wire inside a `TriageRequest` that
  // declares it `WorkspaceGoal[]` — the next reader of that field is the one
  // who finds out. Validate everything non-optional, not just what today's
  // readers happen to touch.
  it('a truncated sidecar loses the ask, not the workspace', () => {
    const { ws } = board({ lead: null });
    const { ids: G } = submit(ws.id, [{ key: 'g1', title: 'Reviewer trust' }]);
    const path = pendingBucketReviewPath(dataDir, ws.id);
    const full = JSON.parse(readFileSync(path, 'utf8')) as { pending: PendingBucketReview };
    // Flush the workspace itself, or every reload below reports "no such
    // workspace" and the absences are vacuous for the wrong reason.
    store.stop();

    const reload = () => {
      const s = new TaskStore({ dataDir, debounceMs: 5 });
      wire(s);
      const got = s.getPendingBucketReview(ws.id);
      s.stop();
      return got;
    };
    // Positive control: the intact record round-trips through a fresh store,
    // so a refusal below is about the missing field and not about the reload.
    expect(reload()?.newBands.map((b) => b.id)).toEqual([G.g1]);

    for (const key of ['oldGoals', 'newGoals', 'ts', 'actor'] as const) {
      const { [key]: _dropped, ...rest } = full.pending;
      writeFileSync(path, `${JSON.stringify({ pending: rest }, null, 2)}\n`);
      expect(reload(), `a sidecar missing ${key} must not load`).toBeUndefined();
    }
    // ...and the intact record still loads afterwards, so the loop is not
    // passing because something earlier in it broke the fixture.
    writeFileSync(path, `${JSON.stringify({ pending: full.pending }, null, 2)}\n`);
    expect(reload()?.newBands.map((b) => b.id)).toEqual([G.g1]);

    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  it('delete_workspace removes the sidecar', () => {
    const { ws } = board({ lead: null });
    submit(ws.id, [{ key: 'g1', title: 'Ship it' }]);
    expect(existsSync(pendingBucketReviewPath(dataDir, ws.id))).toBe(true);
    // The bucket tasks are open, so the delete has to be the explicit one.
    expect(store.deleteWorkspace(ws.id, { force: true }).ok).toBe(true);
    expect(existsSync(pendingBucketReviewPath(dataDir, ws.id))).toBe(false);
  });
});
