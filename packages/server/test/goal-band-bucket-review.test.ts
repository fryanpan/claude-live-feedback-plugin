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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
      const res = store.setGoalList(ws.id, [{ id: 'g1', title: 'Ship the review surface' }], {
        actor: PERSON,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const reviews = bucketReviews();
      expect(reviews.length).toBe(1);
      const req = reviews[0];
      if (req?.kind !== 'bucket-review') throw new Error('unreachable');
      expect(req.taskIds.sort()).toEqual([...ids].sort());
      expect(req.newBands).toEqual([{ id: 'g1', title: 'Ship the review surface' }]);
      // Its own baseline: the goal LIST before and after, not the north star.
      expect(req.oldGoals).toEqual([]);
      expect(req.newGoals.map((g) => g.id)).toEqual(['g1']);
      expect(req.leadAgentId).toBe(LEAD);
      // The caller gets the same answer the north-star path gives.
      expect(res.bucketReview.requested).toBe(true);
      expect(res.bucketReview.queued).toBe(false);
      expect(res.bucketReview.taskIds.sort()).toEqual([...ids].sort());
    });

    it('a new SUBGOAL is a new band too — it is a destination a task can be placed on', () => {
      const { ws } = board();
      store.setGoalList(ws.id, [{ id: 'g1', title: 'Ship it' }], { actor: PERSON });
      requests.length = 0;
      store.setGoalList(
        ws.id,
        [{ id: 'g1', title: 'Ship it', subgoals: [{ id: 'g1a', title: 'Mobile pass' }] }],
        { actor: PERSON },
      );
      const req = bucketReviews()[0];
      if (req?.kind !== 'bucket-review') throw new Error('expected a bucket review');
      expect(req.newBands).toEqual([{ id: 'g1a', title: 'Mobile pass' }]);
    });

    it('a task swept to Chores by the same edit is in the bucket it asks about', () => {
      const ws = store.createWorkspace('board', 'North star.', { leadAgentId: LEAD });
      store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      store.setGoalList(ws.id, [{ id: 'old', title: 'Old band' }], { actor: PERSON });
      const t = store.createTask(ws.id, { title: 'ported from the old band', goal: 'old' });
      if (!t.ok) throw new Error('fixture');
      requests.length = 0;
      // Replace the band: the open task is swept to Chores AND a band appears.
      store.setGoalList(ws.id, [{ id: 'new', title: 'New band' }], {
        actor: PERSON,
        drop: ['old'],
      });
      const req = bucketReviews()[0];
      if (req?.kind !== 'bucket-review') throw new Error('expected a bucket review');
      expect(req.taskIds).toEqual([t.task.id]);
    });

    it('never places anything — the bucket tasks are untouched', () => {
      const { ws, ids } = board();
      store.setGoalList(ws.id, [{ id: 'g1', title: 'Ship it' }], { actor: PERSON });
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
      store.setGoalList(
        b.ws.id,
        [
          { id: 'g1', title: 'One' },
          { id: 'g2', title: 'Two' },
        ],
        { actor: PERSON },
      );
      requests.length = 0;
      return b;
    };

    it('reorder_goals emits nothing', () => {
      const { ws } = twoBands();
      const res = store.reorderGoals(ws.id, ['g2', 'g1'], { actor: PERSON });
      expect(res.ok).toBe(true);
      expect(requests.length).toBe(0);
      expect(existsSync(pendingBucketReviewPath(dataDir, ws.id))).toBe(false);
    });

    it('a reorder submitted through set_goal_list emits nothing', () => {
      const { ws } = twoBands();
      const res = store.setGoalList(
        ws.id,
        [
          { id: 'g2', title: 'Two' },
          { id: 'g1', title: 'One' },
        ],
        { actor: PERSON },
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(bucketReviews().length).toBe(0);
      expect(res.bucketReview.requested).toBe(false);
      expect(res.bucketReview.queued).toBe(false);
    });

    it('a retitle in place emits nothing — same ids, no new destination', () => {
      const { ws } = twoBands();
      store.setGoalList(
        ws.id,
        [
          { id: 'g1', title: 'One, reworded' },
          { id: 'g2', title: 'Two' },
        ],
        { actor: PERSON },
      );
      expect(bucketReviews().length).toBe(0);
    });

    it('rename_goal emits nothing', () => {
      const { ws } = twoBands();
      store.renameGoal(ws.id, 'g1', { title: 'One, renamed' }, { actor: PERSON });
      expect(bucketReviews().length).toBe(0);
    });

    it('a band appearing over an EMPTY bucket emits nothing', () => {
      const ws = store.createWorkspace('board', 'North star.', { leadAgentId: LEAD });
      store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      store.createTask(ws.id, { title: 'a deliberate chore', goal: 'chores' });
      requests.length = 0;
      const res = store.setGoalList(ws.id, [{ id: 'g1', title: 'Ship it' }], { actor: PERSON });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(requests.length).toBe(0);
      expect(res.bucketReview.taskIds).toEqual([]);
    });
  });

  describe('durability — its own slot, replayed on the lead’s next attach', () => {
    it('an undelivered request persists to its OWN sidecar and leaves the retriage one alone', () => {
      const { ws, ids } = board({ lead: null });
      const res = store.setGoalList(ws.id, [{ id: 'g1', title: 'Ship it' }], { actor: PERSON });
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
      expect(pending?.newBands).toEqual([{ id: 'g1', title: 'Ship it' }]);
      expect(pending?.oldGoals).toEqual([]);
      // Drained by that call — a second attach is offered nothing.
      const again = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      expect(again.ok && again.pendingBucketReview).toBeUndefined();
      expect(existsSync(pendingBucketReviewPath(dataDir, ws.id))).toBe(false);
    });

    it('a queued north-star retriage and a queued bucket review both survive, separately', () => {
      const { ws } = board({ lead: null });
      store.setWorkspaceGoal(ws.id, 'A different north star.', { actor: PERSON });
      store.setGoalList(ws.id, [{ id: 'g1', title: 'Ship it' }], { actor: PERSON });
      expect(existsSync(pendingRetriagePath(dataDir, ws.id))).toBe(true);
      expect(existsSync(pendingBucketReviewPath(dataDir, ws.id))).toBe(true);
      const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      if (!attach.ok) throw new Error('attach failed');
      // The north-star ask keeps its own TEXT baseline; the band ask keeps
      // the goal LIST. Neither field describes the other's edit.
      expect(attach.pendingRetriage?.oldGoal).toBe('Old north star.');
      expect(attach.pendingBucketReview?.newBands).toEqual([{ id: 'g1', title: 'Ship it' }]);
    });

    it('a non-lead attach leaves it waiting', () => {
      const { ws } = board({ lead: null });
      store.setGoalList(ws.id, [{ id: 'g1', title: 'Ship it' }], { actor: PERSON });
      // Seat the lead explicitly so the bystander cannot claim an empty seat.
      store.setLeadAgent(ws.id, LEAD, { actor: PERSON });
      const bystander = store.attachAgent(ws.id, { agentId: OTHER, runtime: 'claude-code-local' });
      expect(bystander.ok && bystander.pendingBucketReview).toBeUndefined();
      expect(existsSync(pendingBucketReviewPath(dataDir, ws.id))).toBe(true);
    });

    it('survives a restart', () => {
      const { ws, ids } = board({ lead: null });
      store.setGoalList(ws.id, [{ id: 'g1', title: 'Ship it' }], { actor: PERSON });
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
      store.setGoalList(ws.id, [{ id: 'g1', title: 'Ship it' }], { actor: PERSON });
      store.attachAgent(ws.id, { agentId: OTHER, runtime: 'claude-code-local' });
      requests.length = 0;
      // OTHER claimed the empty seat by attaching; hand it to LEAD, who is
      // NOT live — nothing goes out, the request keeps waiting.
      store.setLeadAgent(ws.id, LEAD, { actor: PERSON });
      expect(bucketReviews().length).toBe(0);
      // Now LEAD is live and the seat moves to them: it goes out.
      store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      const drained = store.attachAgent(ws.id, { agentId: OTHER, runtime: 'claude-code-local' });
      expect(drained.ok && drained.pendingBucketReview).toBeUndefined();
    });

    it('two edits in one gap coalesce: first baseline, newest list, unions', () => {
      const { ws, ids } = board({ lead: null });
      store.setGoalList(ws.id, [{ id: 'g1', title: 'One' }], { actor: PERSON });
      const third = store.createTask(ws.id, { title: 'arrived between the two edits' });
      if (!third.ok) throw new Error('fixture');
      store.setGoalList(
        ws.id,
        [
          { id: 'g1', title: 'One' },
          { id: 'g2', title: 'Two' },
        ],
        { actor: PERSON },
      );
      const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      if (!attach.ok) throw new Error('attach failed');
      const pending = attach.pendingBucketReview;
      expect(pending?.oldGoals).toEqual([]);
      expect(pending?.newGoals.map((g) => g.id)).toEqual(['g1', 'g2']);
      expect(pending?.newBands.map((b) => b.id).sort()).toEqual(['g1', 'g2']);
      expect(pending?.taskIds.sort()).toEqual([...ids, third.task.id].sort());
    });
  });

  describe('the replay describes the board as it stands NOW', () => {
    it('a task placed since is dropped from the waiting request', () => {
      const { ws, ids } = board({ lead: null });
      store.setGoalList(ws.id, [{ id: 'g1', title: 'Ship it' }], { actor: PERSON });
      const [first, second] = ids;
      if (!first || !second) throw new Error('fixture');
      store.setTaskGoal(first, 'g1', { actor: PERSON });
      const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      if (!attach.ok) throw new Error('attach failed');
      expect(attach.pendingBucketReview?.taskIds).toEqual([second]);
    });

    it('a request whose whole bucket got placed retires itself', () => {
      const { ws, ids } = board({ lead: null });
      store.setGoalList(ws.id, [{ id: 'g1', title: 'Ship it' }], { actor: PERSON });
      for (const id of ids) store.setTaskGoal(id, 'g1', { actor: PERSON });
      const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      expect(attach.ok && attach.pendingBucketReview).toBeUndefined();
      expect(existsSync(pendingBucketReviewPath(dataDir, ws.id))).toBe(false);
    });

    it('a band removed since is dropped, and a request with no bands left retires', () => {
      const { ws } = board({ lead: null });
      store.setGoalList(
        ws.id,
        [
          { id: 'g1', title: 'One' },
          { id: 'g2', title: 'Two' },
        ],
        { actor: PERSON },
      );
      store.setGoalList(ws.id, [{ id: 'g1', title: 'One' }], { actor: PERSON });
      const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      if (!attach.ok) throw new Error('attach failed');
      expect(attach.pendingBucketReview?.newBands.map((b) => b.id)).toEqual(['g1']);

      // And when EVERY band that appeared has since gone, the ask retires
      // rather than naming a band that no longer exists.
      const { ws: ws2 } = board({ lead: null });
      store.setGoalList(ws2.id, [{ id: 'gx', title: 'Temporary' }], { actor: PERSON });
      store.setGoalList(ws2.id, [], { actor: PERSON });
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
      store.setGoalList(ws.id, [{ id: 'g1', title: 'Provisional name' }], { actor: PERSON });
      store.renameGoal(ws.id, 'g1', { title: 'Reviewer trust' }, { actor: PERSON });
      const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      if (!attach.ok) throw new Error('attach failed');
      expect(attach.pendingBucketReview?.newBands).toEqual([{ id: 'g1', title: 'Reviewer trust' }]);
    });

    it('(control) an unrenamed band keeps the title it appeared with', () => {
      const { ws } = board({ lead: null });
      store.setGoalList(ws.id, [{ id: 'g1', title: 'Reviewer trust' }], { actor: PERSON });
      const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      if (!attach.ok) throw new Error('attach failed');
      expect(attach.pendingBucketReview?.newBands).toEqual([{ id: 'g1', title: 'Reviewer trust' }]);
    });
  });

  it('delete_workspace removes the sidecar', () => {
    const { ws } = board({ lead: null });
    store.setGoalList(ws.id, [{ id: 'g1', title: 'Ship it' }], { actor: PERSON });
    expect(existsSync(pendingBucketReviewPath(dataDir, ws.id))).toBe(true);
    // The bucket tasks are open, so the delete has to be the explicit one.
    expect(store.deleteWorkspace(ws.id, { force: true }).ok).toBe(true);
    expect(existsSync(pendingBucketReviewPath(dataDir, ws.id))).toBe(false);
  });
});
