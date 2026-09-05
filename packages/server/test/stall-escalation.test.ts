/**
 * The board going over its lead's head.
 *
 * The gap: `stall-nudge.ts` wakes the lead and stops, so a board whose lead
 * has died, run out of quota, or is itself waiting on somebody keeps being
 * told about rows nobody can act on, and no person ever hears. This suite
 * drives `StallEscalations` directly against a real `TaskStore`, because the
 * thing under test is what lands on a reader's queue — one item, revised as
 * the set moves, withdrawn when it empties, and never a second one.
 *
 * Every clock is passed in (`now`) rather than waited for: the module takes
 * the tick's time as an argument, so an hour is a number here and no test
 * sleeps. The one clock that is real is the STORE's — `addReviewItem` stamps
 * `updatedAt` itself — which is exactly why the record keeps the write's own
 * timestamp rather than the tick's.
 *
 * All fixtures are synthetic — invented names. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskReviewItems } from '../src/review-queue.ts';
import {
  STALL_ESCALATION_FILENAME,
  StallEscalations,
  buildStallEscalationReview,
} from '../src/stall-escalation.ts';
import type { StalledRow } from '../src/stall-gate.ts';
import { StallNudger, type StallSnapshot, type ToldTime } from '../src/stall-nudge.ts';
import { type Task, TaskStore } from '../src/tasks.ts';

const PERSON = { id: 'known-robin', name: 'Robin Vale', kind: 'person' };
const AGENT = { id: 'agent-tide-runner', name: 'Tide Runner', kind: 'agent' };
/** Short enough to be a number in a test, long enough to be a real window. */
const ESCALATE_MS = 60 * 60_000;

function row(task: Task, bucket: string, quietMs = 90 * 60_000): StalledRow {
  return { id: task.id, title: task.title, bucket, quietMs };
}

/** Told times, delivered unless a test says otherwise. */
function toldMap(entries: ReadonlyArray<[string, number]>): Map<string, ToldTime> {
  return new Map(entries.map(([id, at]) => [id, { at, delivered: true }]));
}

function board(workspaceId: string, parts: Partial<StallSnapshot> = {}): StallSnapshot {
  return {
    workspaceId,
    leadAgentId: AGENT.id,
    retired: false,
    stalled: [],
    unfiled: [],
    considered: 4,
    undetermined: [],
    ...parts,
  };
}

describe('a told row that has not moved escalates to the reader', () => {
  let dataDir: string;
  let store: TaskStore;
  let escalations: StallEscalations;
  let wsId: string;
  let now: number;

  const make = (title: string): Task => {
    const created = store.createTask(wsId, { title, assignee: AGENT.name });
    if (!created.ok) throw new Error(`create failed: ${created.error}`);
    return created.task;
  };
  const items = (taskId: string) => store.listReviewItems(taskId);
  const openItems = (taskId: string) =>
    items(taskId).filter((i) => i.answer === undefined && i.review.withdrawnAt === undefined);
  /**
   * What the READER's queue actually shows, through the same function Home
   * builds it with. Open is not the same as visible: `taskReviewItems` drops
   * a done ticket's rows, a withdrawn item and one whose state is `waiting`,
   * so an item can be open forever and reach nobody.
   */
  const queued = () =>
    taskReviewItems(
      store.listTasks(wsId).map((t) => ({
        id: t.id,
        title: t.title,
        bodyDocId: `task:${t.id}`,
        done: t.status === 'done',
        reviews: store.listReviewItems(t.id),
      })),
    );

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'stall-escalation-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    wsId = store.createWorkspace('Tide board').id;
    escalations = new StallEscalations({
      store,
      dataDir,
      escalateMs: ESCALATE_MS,
      report: () => {},
    });
    now = Date.now() + 10 * 60_000;
  });

  afterEach(() => {
    // Back to the real clock whatever the test did with it, so a pinned one
    // can never leak into the test that runs next.
    setSystemTime();
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('files ONE item, on the unfiled row, naming every stuck row with a relative link', () => {
    const a = make('Cut the export path over to the new writer');
    const b = make('Retire the second scheduler');
    const told = toldMap([
      [a.id, now - ESCALATE_MS - 60_000],
      [b.id, now - ESCALATE_MS - 30 * 60_000],
    ]);
    escalations.onBoard(
      board(wsId, {
        unfiled: [row(a, 'blocked-on-owner-unfiled')],
        stalled: [row(b, 'in-progress')],
      }),
      told,
      now,
    );

    // The anchor is the UNFILED row even though the stalled one was told
    // longer ago: hanging the ask there costs no stall visibility.
    expect(openItems(a.id)).toHaveLength(1);
    expect(items(b.id)).toHaveLength(0);
    const detail = openItems(a.id)[0]?.review.detail ?? '';
    expect(detail).toContain(`(/workspaces/${wsId}?task=${a.id})`);
    expect(detail).toContain(`(/workspaces/${wsId}?task=${b.id})`);
    expect(detail).toContain('no question filed');
    expect(escalations.filedCount()).toBe(1);
    // Never judged. The store door is what the allow-rule proposals use and
    // what this uses; the quality gate lives on the ROUTE, so an item filed
    // here carries no verdict and cannot be held off the reader's queue.
    expect(openItems(a.id)[0]?.judge).toBeUndefined();
  });

  it('does not file a minute before the window, and does at it', () => {
    const a = make('Fold the retry budget into the client');
    const early = toldMap([[a.id, now - ESCALATE_MS + 60_000]]);
    escalations.onBoard(board(wsId, { unfiled: [row(a, 'blocked-on-owner-unfiled')] }), early, now);
    expect(items(a.id)).toHaveLength(0);

    const due = toldMap([[a.id, now - ESCALATE_MS]]);
    escalations.onBoard(board(wsId, { unfiled: [row(a, 'blocked-on-owner-unfiled')] }), due, now);
    expect(openItems(a.id)).toHaveLength(1);
  });

  it('a row the lead was never told about never escalates, however quiet', () => {
    const a = make('Rewrite the ingest doc');
    escalations.onBoard(
      board(wsId, { stalled: [row(a, 'in-progress', 6 * 60 * 60_000)] }),
      new Map(),
      now,
    );
    expect(items(a.id)).toHaveLength(0);
  });

  it('a second qualifying row REVISES the same item rather than filing another', () => {
    const a = make('Move the queue drain off the request path');
    const b = make('Delete the shim nobody imports');
    const told = toldMap([[a.id, now - ESCALATE_MS - 60_000]]);
    escalations.onBoard(board(wsId, { unfiled: [row(a, 'blocked-on-owner-unfiled')] }), told, now);
    const first = openItems(a.id)[0];
    expect(first).toBeDefined();
    expect((first?.review.detail ?? '').includes(b.id)).toBe(false);

    // `a` is now masked by the item we just filed — the gate stops naming it —
    // and `b` has crossed the window.
    told.set(b.id, { at: now - ESCALATE_MS - 60_000, delivered: true });
    escalations.onBoard(board(wsId, { stalled: [row(b, 'in-progress')] }), told, now + 60_000);
    const after = openItems(a.id);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(first?.id);
    expect(after[0]?.review.detail ?? '').toContain(b.id);
    // The words it replaced are kept, not overwritten.
    expect(after[0]?.revisions?.length).toBe(1);
    expect(items(b.id)).toHaveLength(0);
  });

  it('withdraws the item when the rows it named are moving again', () => {
    const a = make('Ship the digest job');
    const told = toldMap([[a.id, now - ESCALATE_MS - 60_000]]);
    escalations.onBoard(board(wsId, { unfiled: [row(a, 'blocked-on-owner-unfiled')] }), told, now);
    expect(openItems(a.id)).toHaveLength(1);

    // Somebody finished it: the anchor's ticket is closed, so it no longer
    // counts even though the gate cannot see it while our item is open.
    store.transition(a.id, 'done', { actor: PERSON });
    escalations.onBoard(board(wsId), told, now + 60_000);
    expect(openItems(a.id)).toHaveLength(0);
    expect(items(a.id)[0]?.review.withdrawnAt).toBeGreaterThan(0);
    expect(escalations.filedCount()).toBe(0);
  });

  it('keeps the item open while the anchor is masked by the item itself', () => {
    const a = make('Take the lock off the writer');
    const told = toldMap([[a.id, now - ESCALATE_MS - 60_000]]);
    escalations.onBoard(board(wsId, { unfiled: [row(a, 'blocked-on-owner-unfiled')] }), told, now);
    const filed = openItems(a.id)[0]?.id;

    // Three ticks with the row absent from the gate's lists — which is what
    // our own filing causes — must not take the item back. This is the
    // blink-on-blink-off loop the anchor test exists to prevent.
    for (const tick of [1, 2, 3]) escalations.onBoard(board(wsId), told, now + tick * 60_000);
    expect(openItems(a.id).map((i) => i.id)).toEqual([filed ?? '']);
  });

  it('does not re-file for rows the reader has already answered about', () => {
    const a = make('Split the parser out of the loader');
    const told = toldMap([[a.id, now - ESCALATE_MS - 60_000]]);
    escalations.onBoard(board(wsId, { unfiled: [row(a, 'blocked-on-owner-unfiled')] }), told, now);
    const filed = openItems(a.id)[0]?.id ?? '';
    store.answerTaskReview(a.id, filed, 'Looking at it now', { actor: PERSON });

    // The row is still stuck and still told about; the reader has spoken.
    escalations.onBoard(
      board(wsId, { unfiled: [row(a, 'blocked-on-owner-unfiled')] }),
      told,
      now + 60_000,
    );
    expect(items(a.id)).toHaveLength(1);
  });

  it('a retired board escalates nothing', () => {
    const a = make('Archive the old importer');
    const told = toldMap([[a.id, now - ESCALATE_MS - 60_000]]);
    escalations.onBoard(
      board(wsId, { retired: true, unfiled: [row(a, 'blocked-on-owner-unfiled')] }),
      told,
      now,
    );
    expect(items(a.id)).toHaveLength(0);
  });

  it('a restart reads the sidecar and does not file a second item', () => {
    const a = make('Land the backfill');
    const told = toldMap([[a.id, now - ESCALATE_MS - 60_000]]);
    const snapshot = board(wsId, { unfiled: [row(a, 'blocked-on-owner-unfiled')] });
    escalations.onBoard(snapshot, told, now);
    expect(openItems(a.id)).toHaveLength(1);
    expect(readFileSync(join(dataDir, STALL_ESCALATION_FILENAME), 'utf8')).toContain(a.id);

    const restarted = new StallEscalations({
      store,
      dataDir,
      escalateMs: ESCALATE_MS,
      report: () => {},
    });
    restarted.onBoard(snapshot, told, now + 60_000);
    restarted.onBoard(snapshot, told, now + 120_000);
    expect(openItems(a.id)).toHaveLength(1);
    expect(restarted.filedCount()).toBe(1);
  });

  it('waits out a cooldown before escalating the same board again', () => {
    const a = make('Rebuild the index on boot');
    const told = toldMap([[a.id, now - ESCALATE_MS - 60_000]]);
    escalations.onBoard(board(wsId, { unfiled: [row(a, 'blocked-on-owner-unfiled')] }), told, now);
    const first = openItems(a.id)[0]?.id;
    store.transition(a.id, 'done', { actor: PERSON });
    escalations.onBoard(board(wsId), told, now + 60_000);
    expect(openItems(a.id)).toHaveLength(0);

    // The row comes straight back. Inside the cooldown nothing is filed…
    const b = make('Rebuild the index on boot, again');
    told.set(b.id, { at: now - ESCALATE_MS - 60_000, delivered: true });
    const back = board(wsId, { unfiled: [row(b, 'blocked-on-owner-unfiled')] });
    escalations.onBoard(back, told, now + 120_000);
    expect(items(b.id)).toHaveLength(0);
    // …and past it, the board may speak again.
    escalations.onBoard(back, told, now + 60_000 + ESCALATE_MS + 1);
    const filed = openItems(b.id);
    expect(filed).toHaveLength(1);
    expect(filed[0]?.id).not.toBe(first);
  });

  it('MOVES the item to a row that still qualifies when the anchor closes', () => {
    const a = make('Cut the reader over to the new index');
    const b = make('Drain the queue the old reader left');
    const told = toldMap([
      [a.id, now - ESCALATE_MS - 60_000],
      [b.id, now - ESCALATE_MS - 60_000],
    ]);
    const both = board(wsId, {
      unfiled: [row(a, 'blocked-on-owner-unfiled')],
      stalled: [row(b, 'in-progress')],
    });
    escalations.onBoard(both, told, now);
    expect(openItems(a.id)).toHaveLength(1);

    // The anchor gets finished while `b` stays stuck. Revised in place, the
    // ask would sit open on a done ticket — invisible to the queue forever,
    // with `b` never reported because the board already has "an item".
    store.transition(a.id, 'done', { actor: PERSON });
    escalations.onBoard(board(wsId, { stalled: [row(b, 'in-progress')] }), told, now + 60_000);

    expect(openItems(a.id)).toHaveLength(0);
    expect(openItems(b.id)).toHaveLength(1);
    expect(escalations.filedCount()).toBe(1);
    const rows = queued();
    expect(rows.map((r) => r.taskId)).toEqual([b.id]);
    expect(rows[0]?.review.detail ?? '').toContain(`(/workspaces/${wsId}?task=${b.id})`);
  });

  it('re-anchors in the same tick, with no cooldown between the two', () => {
    const a = make('Retire the legacy exporter');
    const b = make('Point the dashboards at the new table');
    const told = toldMap([
      [a.id, now - ESCALATE_MS - 60_000],
      [b.id, now - ESCALATE_MS - 60_000],
    ]);
    escalations.onBoard(board(wsId, { unfiled: [row(a, 'blocked-on-owner-unfiled')] }), told, now);
    store.transition(a.id, 'done', { actor: PERSON });

    // One tick, one second later: well inside the re-file cooldown, which
    // exists for a board that keeps flickering and not for an ask being
    // carried to a row the reader can see.
    escalations.onBoard(
      board(wsId, { unfiled: [row(b, 'blocked-on-owner-unfiled')] }),
      told,
      now + 1_000,
    );
    expect(openItems(b.id)).toHaveLength(1);
  });

  it('withdraws the item it already filed when the board is retired', () => {
    const a = make('Sweep the orphaned uploads');
    const told = toldMap([[a.id, now - ESCALATE_MS - 60_000]]);
    escalations.onBoard(board(wsId, { unfiled: [row(a, 'blocked-on-owner-unfiled')] }), told, now);
    expect(openItems(a.id)).toHaveLength(1);

    // Retiring a board is the owner saying nobody is working it. The gate
    // names nothing on it, so the qualifying set is empty — and the anchor
    // would otherwise be re-read off its own ticket and keep the item alive.
    escalations.onBoard(board(wsId, { retired: true }), told, now + 60_000);
    expect(openItems(a.id)).toHaveLength(0);
    expect(items(a.id)[0]?.review.withdrawnAt).toBeGreaterThan(0);
    expect(escalations.filedCount()).toBe(0);
    expect(queued()).toHaveLength(0);
  });

  it('an item the reader asked back on is REVISED, not moved, when a row joins it', () => {
    const a = make('Split the ingest worker in two');
    const b = make('Retire the duplicate cron');
    const told = toldMap([[a.id, now - ESCALATE_MS - 60_000]]);
    escalations.onBoard(board(wsId, { unfiled: [row(a, 'blocked-on-owner-unfiled')] }), told, now);
    const filed = openItems(a.id)[0]?.id ?? '';

    // The reader asks back, doc-style — a question anchored on a thread is
    // what puts the item in `waiting`, and `waiting` leaves the queue: it is
    // the owner's turn, on a ticket that is very much alive.
    //
    // The STORE's clock is pinned across these two writes, and only here.
    // Asking a question WRITES to the ticket, so `updatedAt` moves — and
    // `anchorHolds` reads that field to ask whether anybody else has touched
    // the row. Left to the real clock this test passed only when the question
    // and the filing landed in the same millisecond; one millisecond later the
    // module read the reader's own question as the row moving and re-anchored,
    // which is the failure this test is named for (it flaked in CI on a branch
    // that touches no stall file). So the ordering is made explicit — a second
    // between them, no sleep — and the module now discounts writes its own
    // item explains.
    const asked = Date.now() + 1000;
    setSystemTime(asked);
    store.requestMoreInfoOnReview(a.id, filed, 'Which of these is holding the other up?', {
      actor: PERSON,
      threadId: 'th-reader-asked-back',
    });
    expect(queued()).toHaveLength(0);

    setSystemTime(asked + 1000);
    told.set(b.id, { at: now - ESCALATE_MS - 60_000, delivered: true });
    escalations.onBoard(board(wsId, { stalled: [row(b, 'in-progress')] }), told, now + 60_000);

    // Revising is itself the answer to their turn, so the SAME item comes
    // back to the queue carrying both rows. Re-anchoring here would have
    // dropped the thread they started.
    const rows = queued();
    expect(rows.map((r) => r.reviewItemId)).toEqual([filed]);
    expect(rows[0]?.taskId).toBe(a.id);
    expect(rows[0]?.review.detail ?? '').toContain(b.id);
    expect(items(b.id)).toHaveLength(0);
  });

  it('says nobody could be reached when no wake was ever delivered', () => {
    const a = make('Re-point the importer at the new bucket');
    const told = new Map([[a.id, { at: now - ESCALATE_MS - 60_000, delivered: false }]]);
    // The case the whole feature opened with: a board whose lead seat is held
    // by a session that has died, so the wake was owed for an hour and went
    // nowhere. Escalating on a DELIVERED wake alone would never fire here.
    escalations.onBoard(board(wsId, { stalled: [row(a, 'in-progress')] }), told, now);
    const item = openItems(a.id)[0];
    expect(item?.review.headline ?? '').toContain('Nobody could be reached');
    expect(item?.review.detail ?? '').toContain('not answering');
    expect(queued()).toHaveLength(1);
  });
});

describe('when the lead was told, as the nudger measures it', () => {
  const heard: Array<{ ws: string; told: ReadonlyMap<string, ToldTime>; now: number }> = [];
  const stuck = { id: 't-9', title: 'Land the reader fix', bucket: 'in-progress', quietMs: 60_000 };

  const nudgerAt = (clock: () => number, reachable: boolean) =>
    new StallNudger({
      snapshot: () => [board('ws-told', { stalled: [stuck] })],
      canReach: () => reachable,
      send: () => 1,
      now: clock,
      escalate: (b, told, now) => heard.push({ ws: b.workspaceId, told: new Map(told), now }),
    });

  beforeEach(() => {
    heard.length = 0;
  });

  it('stamps the told time on a DELIVERED wake and never restarts it', () => {
    let t = 1_000_000;
    const nudger = nudgerAt(() => t, true);
    nudger.tick();
    expect(heard[0]?.told.get(stuck.id)).toEqual({ at: t, delivered: true });
    const first = t;
    t += 30 * 60_000;
    nudger.tick();
    // Seen again, told once: the escalation clock measures the stretch, not
    // the last time anybody looked.
    expect(heard[1]?.told.get(stuck.id)).toEqual({ at: first, delivered: true });
  });

  it('the told time survives a restart, so the clock is not reset by a deploy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stall-told-'));
    const stampFile = join(dir, 'stamps.json');
    const build = (clock: () => number) =>
      new StallNudger({
        snapshot: () => [board('ws-told', { stalled: [stuck] })],
        canReach: () => true,
        send: () => 1,
        now: clock,
        stampFile,
        escalate: (b, told, now) => heard.push({ ws: b.workspaceId, told: new Map(told), now }),
      });
    const told = 3_000_000;
    build(() => told).tick();
    expect(heard[0]?.told.get(stuck.id)).toEqual({ at: told, delivered: true });

    // Prod restarts at every merge. A clock that started again there would
    // hand every board another full window before anybody heard.
    build(() => told + 45 * 60_000).tick();
    expect(heard[1]?.told.get(stuck.id)).toEqual({ at: told, delivered: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('a finding nobody could be reached about stamps its own clock, undelivered', () => {
    const nudger = nudgerAt(() => 2_000_000, false);
    nudger.tick();
    // The wake stays owed — nothing is recorded as told — but the board knows
    // when it first had nobody to tell, which is the case this whole feature
    // opened with: a lead session that had died with nothing else attached.
    expect(heard[0]?.told.get(stuck.id)).toEqual({ at: 2_000_000, delivered: false });
  });

  it('the undeliverable clock starts once, not on every tick', () => {
    let t = 5_000_000;
    const nudger = nudgerAt(() => t, false);
    nudger.tick();
    t += 20 * 60_000;
    nudger.tick();
    expect(heard[1]?.told.get(stuck.id)).toEqual({ at: 5_000_000, delivered: false });
  });
});

describe('the escalation cannot take the stall loop down with it', () => {
  it('a filer that throws costs its own board and nothing else', () => {
    const seen: string[] = [];
    const boards: StallSnapshot[] = [board('ws-one'), board('ws-two')];
    const nudger = new StallNudger({
      snapshot: () => boards,
      canReach: () => false,
      send: () => 0,
      escalate: (b) => {
        seen.push(b.workspaceId);
        if (b.workspaceId === 'ws-one') throw new Error('sidecar is on fire');
      },
    });
    expect(() => nudger.tick()).not.toThrow();
    expect(seen).toEqual(['ws-one', 'ws-two']);
  });
});

describe('the words a reader sees', () => {
  const rows = [
    {
      id: 't-1',
      title: 'Cut the export path over',
      bucket: 'blocked-on-owner-unfiled',
      quietMs: 3 * 60 * 60_000,
      toldMs: 2 * 60 * 60_000,
      delivered: true,
    },
  ];

  it('names the row once, in plain words, with a relative link and both spans', () => {
    const review = buildStallEscalationReview({
      workspaceId: 'w-abc',
      rows,
      escalateMs: ESCALATE_MS,
    }) as { review_type: string; headline: string; detail: string; options?: unknown };
    expect(review.review_type).toBe('question');
    // A question is answered in the reader's own words — options would be a
    // decision, and there is nothing here to choose between.
    expect(review.options).toBeUndefined();
    expect(review.headline).toContain('Cut the export path over');
    expect(review.headline.includes('\n')).toBe(false);
    expect(review.detail).toContain('[Cut the export path over](/workspaces/w-abc?task=t-1)');
    expect(review.detail).toContain('Quiet 3h');
    expect(review.detail).toContain('told 2h ago');
  });

  it('counts the rows in the headline when there is more than one', () => {
    const review = buildStallEscalationReview({
      workspaceId: 'w-abc',
      rows: [...rows, { ...rows[0], id: 't-2', title: 'Retire the scheduler' } as (typeof rows)[0]],
      escalateMs: ESCALATE_MS,
    }) as { headline: string };
    expect(review.headline).toBe('2 rows have not moved since the lead was told');
  });
});
