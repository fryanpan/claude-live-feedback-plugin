/**
 * A goal has a description and a discussion, like every other row on the board.
 *
 * Bryan reopened the goals-as-a-task-type ticket on 2026-08-24: *"Goals are
 * missing a bunch of the usual ticket behaviour -- no description? no
 * comments? They're not at parity."* The status/owner/band work shipped; the
 * two things a goal is FOR — saying what it means, and arguing about it — did
 * not.
 *
 * The design settled the naming question this suite pins: a goal's body room
 * is `task:<goalId>`, not `goal:<goalId>`. Goal ids are `g-…` and task ids are
 * `t-…`, so the namespace cannot collide, and reusing the prefix means
 * `isHubOwnedRoom`, every prose edit tool, the thread store, the SSE redactors
 * and the doc routes all work on a goal body with no change at all. A second
 * prefix would have been an edit to each of them buying nothing.
 *
 * What is asserted here is the machinery a goal did NOT inherit for free —
 * every one of these was a `getTask` lookup that misses on a goal row and
 * fails silently:
 *
 *  - the room has to be CREATED for a goal (nothing calls `ensureTaskBody`
 *    for one), or an agent's first `get_doc` lands on an empty stranger;
 *  - the write-back has to reach `GoalRow.body` (`updateBodySnapshot` reads
 *    `getTask`), or every description is lost on restart;
 *  - the projection has to carry it, or the board cannot draw what the store
 *    holds — this file's recurring bug;
 *  - a comment has to BROADCAST (`onDocRoomEvent` resolves the workspace via
 *    `getTask`), or an agent watching the board never hears it;
 *  - a review item on a goal thread has to reach the Home queue, or "ask
 *    Bryan about this goal" is a comment nobody is told about.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ServerHandle, createServer } from '../src/server.ts';
import { seedGoalsOverHttp } from './goal-seed.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known' };

const settle = (ms = 450) => new Promise((r) => setTimeout(r, ms));

describe('a goal is at parity with a task: description + comments', () => {
  let dir: string;
  let handle: ServerHandle;
  let base: string;
  let workspaceId: string;
  let goalId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'goal-parity-'));
    handle = await createServer({ dataDir: dir, port: 0 });
    base = `http://127.0.0.1:${handle.port}`;
    const ws = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Board', author: PERSON }),
    });
    workspaceId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    const ids = await seedGoalsOverHttp(
      base,
      workspaceId,
      [{ key: 'reach', title: 'Reach the first ten teams' }],
      PERSON,
    );
    goalId = ids.reach ?? '';
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const bodyDoc = () => `task:${encodeURIComponent(goalId)}`;

  const readWorkspace = async (): Promise<{
    goalSummary: Array<{ id: string; bodyDocId?: string; commentCount?: number }>;
  }> => {
    const res = await fetch(`${base}/api/workspaces/${encodeURIComponent(workspaceId)}`);
    return (await res.json()) as {
      goalSummary: Array<{ id: string; bodyDocId?: string; commentCount?: number }>;
    };
  };

  const goalRow = async () => {
    const rows = (await readWorkspace()).goalSummary;
    const row = rows.find((r) => r.id === goalId);
    if (!row) throw new Error('goal row missing from the summary');
    return row;
  };

  /** The positive control every "it isn't there" below leans on: the summary
   *  really does describe THIS goal, so an absent field is an absent field
   *  rather than a lookup that found nothing. */
  it('names the goal body room on the goal summary, so an agent can find it', async () => {
    expect((await goalRow()).bodyDocId).toBe(`task:${goalId}`);
  });

  it('serves the goal body room, so a description can be written to it', async () => {
    const res = await fetch(`${base}/api/docs/${bodyDoc()}/content`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: 'Ten teams using it weekly, unprompted.', author: AGENT }),
    });
    expect(res.status).toBe(200);
  });

  it('flushes the goal description back to the store, so it survives a restart', async () => {
    await fetch(`${base}/api/docs/${bodyDoc()}/content`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: 'Ten teams using it weekly, unprompted.', author: AGENT }),
    });
    await settle();
    // Read the STORE, not the room: the room is where the words are typed and
    // the row is what survives a restart, and the write-back between them is
    // the thing that did not exist for a goal (`updateBodySnapshot` reads
    // `getTask`, which misses every goal row and returned false silently).
    expect(handle.tasks.getGoalRow(goalId)?.body ?? '').toContain('Ten teams using it weekly');
  });

  it('takes the goal body room back to its board, so the full editor has a way back', async () => {
    // `workspaceOfDoc` is the same `getTask` miss: it answered null for a
    // goal's room, which is what the back-link, the review URL and share
    // scoping all resolve against.
    expect(handle.tasks.workspaceOfDoc(`task:${goalId}`)).toBe(workspaceId);
  });

  it('projects the goal description onto the board, so the panel can draw it', async () => {
    await fetch(`${base}/api/docs/${bodyDoc()}/content`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: 'Ten teams using it weekly, unprompted.', author: AGENT }),
    });
    await settle();
    // The board renders bands off the `ws:` room's projected `goals` and
    // nothing else, so a body only the store can see is the
    // store-has-it/surface-can't-show-it bug for the field goals exist for.
    const room = handle.rooms.get(`ws:${workspaceId}`);
    const goals = room?.ydoc.getMap('workspace').get('goals') as
      | Array<{ id: string; body?: string; bodyDocId?: string }>
      | undefined;
    const projected = (goals ?? []).find((g) => g.id === goalId);
    expect(projected?.bodyDocId).toBe(`task:${goalId}`);
    expect(projected?.body ?? '').toContain('Ten teams using it weekly');
  });

  it('takes a comment on a goal and counts it on the board, so a band says it has one', async () => {
    const res = await fetch(`${base}/api/docs/${bodyDoc()}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: AGENT,
        text: 'Is ten the right number, or is it ten that renew?',
        anchor: { kind: 'subject' },
      }),
    });
    expect(res.status).toBeLessThan(300);
    await settle();
    const room = handle.rooms.get(`ws:${workspaceId}`);
    const goals = room?.ydoc.getMap('workspace').get('goals') as
      | Array<{ id: string; commentCount?: number }>
      | undefined;
    expect((goals ?? []).find((g) => g.id === goalId)?.commentCount).toBe(1);
  });

  it('puts a declared review item on a goal into the Home queue', async () => {
    const filed = await fetch(`${base}/api/docs/${bodyDoc()}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: AGENT,
        text: 'Ten teams, or ten that renew? The second is a much longer goal.',
        anchor: { kind: 'subject' },
        // A real declaration, not a stub: the filing gate requires `why` and
        // refuses a decision with fewer than two options ("a choice of one is
        // a statement"). A malformed payload is refused identically on a task,
        // so a stub here would have been a test of the gate, not of goals.
        review: {
          shape: 'decision',
          headline: 'Does "ten teams" mean ten that renew?',
          asks: PERSON.name,
          options: [
            { id: 'used', label: 'Ten that have used it' },
            { id: 'renewed', label: 'Ten still using it after a month' },
          ],
        },
      }),
    });
    // The declaration gate is strict and its refusals are 400s with prose. An
    // empty queue below would look identical whether goals are unsupported or
    // the fixture was simply rejected, so the filing is asserted first.
    expect(filed.status).toBeLessThan(300);
    await settle();
    const res = await fetch(
      `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/review-items`,
    );
    const rows = (await res.json()) as { items?: Array<{ kind?: string; docId?: string }> };
    const mine = (rows.items ?? []).filter((i) => i.docId === `task:${goalId}`);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0]?.kind).toBe('goal-thread');
  });
});
