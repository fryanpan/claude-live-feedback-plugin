/**
 * The workspace parallelism cap, end to end (t-GjJAOKpXfLg8: "Bryan and
 * Team Lead can set a parallelism limit on the workspace so that the board
 * keeps moving as fast as the tokens allow without starving higher-priority
 * projects").
 *
 * What is pinned here and nowhere else: the cap SURVIVES A RELOAD (it is a
 * setting, and a setting that resets on restart is a suggestion); its own
 * REST address, which is what Team Lead's session calls; the `next_tasks`
 * trim to free slots; and the stall pass judging only the top <cap> rows of
 * a real board. The dispatch refusal itself lives in dispatch-routes.test.ts
 * and the ready-work trim in ready-nudge-routes.test.ts.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { STALL_EVENT } from '../src/stall-nudge.ts';
import { DEFAULT_PARALLELISM_CAP, TaskStore } from '../src/tasks.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

type Frame = { event: string; data?: Record<string, unknown> };

function listenFrames(res: Response): { frames: Frame[]; stop: () => Promise<void> } {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let buf = '';
  const pump = (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          const frame: Frame = { event: 'message' };
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) frame.event = line.slice(6).trim();
            else if (line.startsWith('data:')) {
              try {
                frame.data = JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>;
              } catch {}
            }
          }
          if (frame.event !== 'message') frames.push(frame);
        }
      }
    } catch {}
  })();
  return {
    frames,
    stop: async () => {
      stopped = true;
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function waitForFrames(
  frames: Frame[],
  event: string,
  n: number,
  timeoutMs = 15_000,
): Promise<Frame[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = frames.filter((f) => f.event === event);
    if (got.length >= n || Date.now() > deadline) return got;
    await settle(20);
  }
}

describe('the cap is a setting on the workspace record', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'parallelism-cap-store-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('defaults to four, and a board that was never asked reads as on the default', () => {
    const store = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      const ws = store.createWorkspace('search-revamp');
      expect(DEFAULT_PARALLELISM_CAP).toBe(4);
      expect(store.parallelismCap(ws.id)).toEqual({ value: 4, isDefault: true });
      expect(store.parallelismCap('w-nope')).toBeUndefined();
    } finally {
      store.stop();
    }
  });

  it('survives a reload: a rehydrated store still carries the number the owner set', async () => {
    const store = new TaskStore({ dataDir, debounceMs: 5 });
    const ws = store.createWorkspace('search-revamp');
    const set = store.setParallelismCap(ws.id, 2, { actor: PERSON });
    expect(set.ok).toBe(true);
    // Let the debounced save land before reading the sidecar back.
    await settle(60);
    store.stop();

    const rehydrated = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      expect(rehydrated.parallelismCap(ws.id)).toEqual({ value: 2, isDefault: false });
    } finally {
      rehydrated.stop();
    }
  });

  it('clearing it puts the board back on the default, durably', async () => {
    const store = new TaskStore({ dataDir, debounceMs: 5 });
    const ws = store.createWorkspace('search-revamp');
    store.setParallelismCap(ws.id, 2, { actor: PERSON });
    store.setParallelismCap(ws.id, undefined, { actor: PERSON });
    await settle(60);
    store.stop();
    const rehydrated = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      expect(rehydrated.parallelismCap(ws.id)).toEqual({ value: 4, isDefault: true });
    } finally {
      rehydrated.stop();
    }
  });
});

describe('the cap through the server', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const put = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (path: string) => fetch(`${base}${path}`);
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'parallelism-cap-'));
    // A zero-length quiet window, as stall-nudge-routes.test.ts uses: every
    // open row is quiet the moment it is read, so what the wake names is
    // decided by the cap alone.
    handle = createServer({
      port: 0,
      dataDir,
      stallNudgeQuietMs: 0,
      // The dispatch watcher is faked so a registered dispatch is
      // deterministic on every platform (see dispatch-routes.test.ts).
      dispatchWatchFactory: () => ({ close: () => {} }),
    });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  interface CapView {
    workspaceId: string;
    cap: number;
    isDefault: boolean;
    default: number;
    inUse: number;
    free: number;
    holders: Array<{ taskId: string; title?: string; agentName?: string }>;
  }

  async function boardWithLead(): Promise<{
    workspaceId: string;
    lead: ReturnType<typeof listenFrames>;
  }> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', leadAgentId: LEAD.id }),
    );
    const workspaceId = workspace.id;
    await jj(
      await post(`/api/workspaces/${workspaceId}/attachments`, {
        agentId: LEAD.id,
        runtime: 'claude-code-local',
      }),
    );
    const leadRes = await fetch(
      `${base}/events/workspace/${workspaceId}?agentId=${encodeURIComponent(LEAD.id)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    return { workspaceId, lead: listenFrames(leadRes) };
  }

  /** One agent-owned row, vetted into `todo` (or on into `in-progress`). */
  async function addRow(
    workspaceId: string,
    title: string,
    to: 'todo' | 'in-progress' = 'todo',
  ): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
      }),
    );
    await jj(
      await post(`/api/tasks/${task.id}/transition`, { to: 'todo', author: PERSON, workspaceId }),
    );
    if (to === 'in-progress') {
      await jj(
        await post(`/api/tasks/${task.id}/transition`, {
          to: 'in-progress',
          author: LEAD,
          workspaceId,
        }),
      );
    }
    return task.id;
  }

  describe('its own REST address', () => {
    it('GET reads the default with nothing in use', async () => {
      const { workspaceId, lead } = await boardWithLead();
      const view = await jj<CapView>(await get(`/api/workspaces/${workspaceId}/parallelism-cap`));
      expect(view).toEqual({
        workspaceId,
        cap: 4,
        isDefault: true,
        default: 4,
        inUse: 0,
        free: 4,
        holders: [],
      });
      await lead.stop();
    });

    it('PUT sets it, reads it back with the slots in use and who holds them, and null restores the default', async () => {
      const { workspaceId, lead } = await boardWithLead();
      const busy = await addRow(workspaceId, 'Migrate the search index', 'in-progress');
      const worktree = mkdtempSync(join(tmpdir(), 'wt-cap-'));
      try {
        await jj(
          await post('/api/dispatches', {
            taskId: busy,
            worktreePath: worktree,
            agentName: 'Builder A',
          }),
        );
        const lowered = await jj<CapView>(
          await put(`/api/workspaces/${workspaceId}/parallelism-cap`, { cap: 1, author: LEAD }),
        );
        // The answer to a PUT is the whole view: the caller that just lowered
        // the cap sees in the same response that the board is already at it.
        expect(lowered).toMatchObject({
          cap: 1,
          isDefault: false,
          default: 4,
          inUse: 1,
          free: 0,
          holders: [{ taskId: busy, title: 'Migrate the search index', agentName: 'Builder A' }],
        });
        // Below the cap: the view says so rather than clamping to zero.
        expect(lowered.free).toBe(0);

        const restored = await jj<CapView>(
          await put(`/api/workspaces/${workspaceId}/parallelism-cap`, { cap: null, author: LEAD }),
        );
        expect(restored).toMatchObject({ cap: 4, isDefault: true, inUse: 1, free: 3 });
        // And the settings panel's read agrees.
        const settings = await jj<{
          parallelismCap: { value: number; isDefault: boolean; default: number };
          dispatchesInUse: number;
        }>(await get(`/api/workspaces/${workspaceId}/settings`));
        expect(settings.parallelismCap).toEqual({ value: 4, isDefault: true, default: 4 });
        expect(settings.dispatchesInUse).toBe(1);
      } finally {
        rmSync(worktree, { recursive: true, force: true });
        await lead.stop();
      }
    });

    it('refuses zero, a fraction, a string, and a missing cap — the floor is one', async () => {
      const { workspaceId, lead } = await boardWithLead();
      for (const body of [{ cap: 0 }, { cap: -1 }, { cap: 1.5 }, { cap: '2' }, {}]) {
        const res = await put(`/api/workspaces/${workspaceId}/parallelism-cap`, {
          ...body,
          author: LEAD,
        });
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      // Nothing above changed the stored value.
      const view = await jj<CapView>(await get(`/api/workspaces/${workspaceId}/parallelism-cap`));
      expect(view.cap).toBe(4);
      expect(view.isDefault).toBe(true);
      await lead.stop();
    });

    it('404s a board that does not exist', async () => {
      expect((await get('/api/workspaces/w-nope/parallelism-cap')).status).toBe(404);
      expect((await put('/api/workspaces/w-nope/parallelism-cap', { cap: 2 })).status).toBe(404);
    });

    it('the workspace read carries the same numbers, so get_workspace can show them', async () => {
      const { workspaceId, lead } = await boardWithLead();
      await jj(
        await put(`/api/workspaces/${workspaceId}/parallelism-cap`, { cap: 2, author: LEAD }),
      );
      const ws = await jj<{ parallelismCap: unknown }>(await get(`/api/workspaces/${workspaceId}`));
      expect(ws.parallelismCap).toEqual({ value: 2, isDefault: false, inUse: 0, free: 2 });
      await lead.stop();
    });
  });

  describe('next_tasks offers at most the free slots', () => {
    interface NextView {
      tasks: Array<{ id: string; status: string }>;
      capacity?: { cap: number; inUse: number; free: number; heldForCapacity?: number };
    }

    it('lists only the top <free> todo rows and says how many it withheld', async () => {
      const { workspaceId, lead } = await boardWithLead();
      const a = await addRow(workspaceId, 'Rank results by recency');
      await addRow(workspaceId, 'Dedupe near-identical rows');
      await addRow(workspaceId, 'Cache the second-page query');
      await jj(
        await put(`/api/workspaces/${workspaceId}/parallelism-cap`, { cap: 1, author: LEAD }),
      );

      const next = await jj<NextView>(await get(`/api/workspaces/${workspaceId}/next`));
      expect(next.tasks.map((t) => t.id)).toEqual([a]);
      expect(next.capacity).toEqual({ cap: 1, inUse: 0, free: 1, heldForCapacity: 2 });
      await lead.stop();
    });

    it('in-progress rows still pass through when every slot is spent — the trim is on offers, not on work in flight', async () => {
      const { workspaceId, lead } = await boardWithLead();
      const busy = await addRow(workspaceId, 'Migrate the search index', 'in-progress');
      await addRow(workspaceId, 'Rank results by recency');
      await jj(
        await put(`/api/workspaces/${workspaceId}/parallelism-cap`, { cap: 1, author: LEAD }),
      );
      const worktree = mkdtempSync(join(tmpdir(), 'wt-cap-'));
      try {
        await jj(await post('/api/dispatches', { taskId: busy, worktreePath: worktree }));
        const next = await jj<NextView>(await get(`/api/workspaces/${workspaceId}/next`));
        expect(next.tasks.map((t) => t.id)).toEqual([busy]);
        expect(next.capacity).toEqual({ cap: 1, inUse: 1, free: 0, heldForCapacity: 1 });

        // Closing the dispatch frees the slot; the very next read offers the
        // row it was withholding.
        await jj(
          await fetch(`${base}/api/dispatches/${encodeURIComponent(busy)}`, { method: 'DELETE' }),
        );
        const after = await jj<NextView>(await get(`/api/workspaces/${workspaceId}/next`));
        expect(after.tasks).toHaveLength(2);
        expect(after.capacity).toEqual({ cap: 1, inUse: 0, free: 1 });
      } finally {
        rmSync(worktree, { recursive: true, force: true });
        await lead.stop();
      }
    });

    it('on the default cap with nothing in use, the queue is untrimmed up to four', async () => {
      const { workspaceId, lead } = await boardWithLead();
      for (const title of ['Rank results by recency', 'Dedupe near-identical rows']) {
        await addRow(workspaceId, title);
      }
      const next = await jj<NextView>(await get(`/api/workspaces/${workspaceId}/next`));
      expect(next.tasks).toHaveLength(2);
      expect(next.capacity).toEqual({ cap: 4, inUse: 0, free: 4 });
      await lead.stop();
    });
  });

  describe('the stall pass judges only the top <cap> rows', () => {
    const stalls = (frames: Frame[]) => frames.filter((f) => f.event === STALL_EVENT);

    it('names the row inside the cap and counts the one beyond it, instead of naming both', async () => {
      const { workspaceId, lead } = await boardWithLead();
      // Two quiet in-progress rows, first-filed first in priority order.
      const top = await addRow(workspaceId, 'Rank results by recency', 'in-progress');
      const beyond = await addRow(workspaceId, 'Dedupe near-identical rows', 'in-progress');
      await jj(
        await put(`/api/workspaces/${workspaceId}/parallelism-cap`, { cap: 1, author: LEAD }),
      );

      // A zero window still needs the clock to tick past the last transition.
      await settle(10);
      handle.nudgeStalls();
      const got = await waitForFrames(lead.frames, STALL_EVENT, 1);
      expect(got).toHaveLength(1);
      const frame = got[0]?.data ?? {};
      expect(frame.stalledCount).toBe(1);
      expect((frame.rows as Array<{ id: string }>).map((r) => r.id)).toEqual([top]);
      expect(frame.beyondCapacity).toBe(1);
      // Both rows were examined — the denominator does not shrink to the cap.
      expect(frame.consideredCount).toBe(2);
      expect(JSON.stringify(frame.rows)).not.toContain(beyond);
      await lead.stop();
    });

    it('on the default cap, a small board is judged whole', async () => {
      const { workspaceId, lead } = await boardWithLead();
      await addRow(workspaceId, 'Rank results by recency', 'in-progress');
      await addRow(workspaceId, 'Dedupe near-identical rows', 'in-progress');

      // A zero window still needs the clock to tick past the last transition.
      await settle(10);
      handle.nudgeStalls();
      const got = await waitForFrames(lead.frames, STALL_EVENT, 1);
      expect(got).toHaveLength(1);
      expect(got[0]?.data?.stalledCount).toBe(2);
      expect(got[0]?.data?.beyondCapacity).toBeUndefined();
      expect(stalls(lead.frames)).toHaveLength(1);
      await lead.stop();
    });
  });
});
