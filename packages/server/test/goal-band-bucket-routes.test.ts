/**
 * The bucket re-look, over HTTP.
 *
 * Every handler in server.ts hand-copies fields into the store call and then
 * hand-copies the answer back out, and the route is the layer nothing
 * type-checks: `groups` was once accepted, 200'd and discarded by exactly
 * this seam. The store-level cases in goal-band-bucket-review.test.ts cannot
 * see a field a route drops, and the SSE frame is a spread
 * (`{ event, ...req }`) that nothing checks against what the MCP renderer
 * needs to read.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = 'agent-lead';
const OTHER = 'agent-bystander';

describe('a new goal band asks the bucket to be re-looked-at, over HTTP', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let baseUrl: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    local(path, { method: 'POST', body: JSON.stringify(body) });
  const put = (path: string, body: unknown) =>
    local(path, { method: 'PUT', body: JSON.stringify(body) });

  type BucketAck = {
    requested: boolean;
    queued: boolean;
    taskIds: string[];
    newBands: Array<{ id: string; title: string }>;
    batchId?: string;
  };

  const makeHub = async (name: string, leadAgentId?: string): Promise<string> => {
    const r = await post('/api/workspaces', {
      name,
      goal: 'Old north star.',
      ...(leadAgentId !== undefined ? { leadAgentId } : {}),
    });
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  };
  /** No `goal` — nobody named a band, so it lands in the bucket. */
  const addUnplaced = async (workspaceId: string, title: string): Promise<string> => {
    const r = await post(`/api/workspaces/${workspaceId}/tasks`, { author: PERSON, title });
    return ((await r.json()) as { task: { id: string } }).task.id;
  };
  const setGoals = async (
    workspaceId: string,
    goals: Array<{ id: string; title: string }>,
  ): Promise<{ bucketReview?: BucketAck }> => {
    const r = await put(`/api/workspaces/${workspaceId}/goals`, { goals, author: PERSON });
    return (await r.json()) as { bucketReview?: BucketAck };
  };
  const attach = async (workspaceId: string, agentId: string) =>
    (await (
      await post(`/api/workspaces/${workspaceId}/attachments`, {
        agentId,
        runtime: 'claude-code-local',
      })
    ).json()) as {
      pendingBucketReview?: { batchId: string; taskIds: string[]; newBands: Array<{ id: string }> };
    };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'band-bucket-routes-'));
    handle = createServer({ port: 0, dataDir });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('the ack survives the route, and an away lead gets the ask on their next attach', async () => {
    const wsId = await makeHub('routed-board', LEAD);
    const first = await addUnplaced(wsId, 'figure out og-images');
    const second = await addUnplaced(wsId, 'audit the empty states');

    // POSITIVE CONTROL: with the lead live the ask is delivered, not queued.
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: LEAD,
      runtime: 'claude-code-local',
    });
    const live = await setGoals(wsId, [{ id: 'g1', title: 'Ship the review surface' }]);
    expect(live.bucketReview?.requested).toBe(true);
    expect(live.bucketReview?.queued).toBe(false);
    expect(live.bucketReview?.taskIds.slice().sort()).toEqual([first, second].sort());
    expect(live.bucketReview?.newBands).toEqual([{ id: 'g1', title: 'Ship the review surface' }]);

    // Now the lead is gone and only a bystander is connected: a connected
    // agent is not the addressee, so the ask waits.
    await local(`/api/workspaces/${wsId}/attachments/${LEAD}`, { method: 'DELETE' });
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: OTHER,
      runtime: 'claude-code-local',
    });
    const away = await setGoals(wsId, [
      { id: 'g1', title: 'Ship the review surface' },
      { id: 'g2', title: 'Reviewer trust' },
    ]);
    expect(away.bucketReview?.requested).toBe(false);
    expect(away.bucketReview?.queued).toBe(true);

    // Handed over through the attach route when the lead comes back.
    const back = await attach(wsId, LEAD);
    expect(back.pendingBucketReview?.batchId).toBe(away.bucketReview?.batchId ?? '');
    expect(back.pendingBucketReview?.taskIds.slice().sort()).toEqual([first, second].sort());
    expect(back.pendingBucketReview?.newBands.map((b) => b.id)).toEqual(['g2']);
  });

  // A request that only exists in a sidecar until somebody attaches is the
  // store-has-it/surface-can't-show-it failure by construction: `queued: true`
  // comes back to the caller and then no reader can see it. The board's own
  // read has to carry it — and must NOT drain it, because reading a board is
  // not answering its ask.
  it('a queued ask is visible on the board read, and reading it does not drain it', async () => {
    const wsId = await makeHub('visible-board', LEAD);
    const first = await addUnplaced(wsId, 'figure out og-images');
    // The lead never attaches, so the ask can only be waiting.
    const queued = await setGoals(wsId, [{ id: 'g1', title: 'Reviewer trust' }]);
    expect(queued.bucketReview?.queued).toBe(true);

    type BoardRead = {
      pendingRetriage?: unknown;
      pendingBucketReview?: { batchId: string; taskIds: string[]; newBands: Array<{ id: string }> };
    };
    const read = async () => (await (await local(`/api/workspaces/${wsId}`)).json()) as BoardRead;

    const board = await read();
    expect(board.pendingBucketReview?.taskIds).toEqual([first]);
    expect(board.pendingBucketReview?.newBands.map((b) => b.id)).toEqual(['g1']);
    // It is its OWN field: a goal-list edit does not touch the north star, so
    // reporting it under pendingRetriage would make that record's goal text
    // lie about what changed.
    expect(board.pendingRetriage).toBeUndefined();

    // Still there on a second read...
    expect((await read()).pendingBucketReview?.taskIds).toEqual([first]);
    // ...and the drain is still the attach. (Positive control for the
    // absence below: this is the call that empties it.)
    expect((await attach(wsId, LEAD)).pendingBucketReview?.taskIds).toEqual([first]);
    expect((await read()).pendingBucketReview).toBeUndefined();
  });

  it('a reorder over the route asks nothing', async () => {
    const wsId = await makeHub('reorder-board', LEAD);
    await addUnplaced(wsId, 'figure out og-images');
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: LEAD,
      runtime: 'claude-code-local',
    });
    await setGoals(wsId, [
      { id: 'g1', title: 'One' },
      { id: 'g2', title: 'Two' },
    ]);
    const reordered = (await (
      await post(`/api/workspaces/${wsId}/goals/reorder`, { order: ['g2', 'g1'], author: PERSON })
    ).json()) as { changed: boolean };
    expect(reordered.changed).toBe(true);
    // Same ids, new order — nothing became apparent.
    const swapped = await setGoals(wsId, [
      { id: 'g2', title: 'Two' },
      { id: 'g1', title: 'One' },
    ]);
    expect(swapped.bucketReview?.requested).toBe(false);
    expect(swapped.bucketReview?.queued).toBe(false);
    expect(swapped.bucketReview?.newBands).toEqual([]);
  });

  /**
   * The live frame has to carry the whole request: the MCP renders its
   * channel line straight off it, so a field lost in the broadcast spread
   * cannot be rendered no matter what the renderer does — and the lead who is
   * HERE would get less than the one who was away and reads
   * `pendingBucketReview` on attach.
   */
  it('the live triage.requested frame carries the bands, the ids and the list baseline', async () => {
    const wsId = await makeHub('wire-board', LEAD);
    const first = await addUnplaced(wsId, 'figure out og-images');
    const second = await addUnplaced(wsId, 'audit the empty states');
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: LEAD,
      runtime: 'claude-code-local',
    });

    const seen: Array<Record<string, unknown>> = [];
    const ctl = new AbortController();
    const stream = await local(`/events/workspace/${wsId}`, { signal: ctl.signal });
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    const pump = (async () => {
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          const frames = buf.split('\n\n');
          buf = frames.pop() ?? '';
          for (const frame of frames) {
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              try {
                seen.push(JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
              } catch {}
            }
          }
        }
      } catch {}
    })();

    try {
      const edit = await setGoals(wsId, [{ id: 'g1', title: 'Ship the review surface' }]);
      expect(edit.bucketReview?.requested).toBe(true); // it really went out live
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !seen.some((e) => e.event === 'triage.requested')) {
        await new Promise((r) => setTimeout(r, 25));
      }

      // POSITIVE CONTROL: this reader can see frames at all. Without it every
      // assertion below could pass vacuously on an empty stream.
      expect(seen.some((e) => e.event === 'workspace.goals_changed')).toBe(true);

      const req = seen.find((e) => e.event === 'triage.requested');
      if (!req) throw new Error('the live delivery never reached the channel');
      expect(req.kind).toBe('bucket-review');
      expect(req.newBands).toEqual([{ id: 'g1', title: 'Ship the review surface' }]);
      expect((req.taskIds as string[]).slice().sort()).toEqual([first, second].sort());
      // The baseline is the goal LIST, and it is on the wire: an empty list
      // before, one band after.
      expect(req.oldGoals).toEqual([]);
      expect((req.newGoals as Array<{ id: string }>).map((g) => g.id)).toEqual(['g1']);
      expect(req.batchId).toBe(edit.bucketReview?.batchId);
      expect(req.leadAgentId).toBe(LEAD);
    } finally {
      ctl.abort();
      await pump;
    }
  });
});
