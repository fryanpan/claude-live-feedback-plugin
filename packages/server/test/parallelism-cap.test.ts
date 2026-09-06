/**
 * The workspace parallelism cap, end to end (Bryan, 2026-08-31: "Bryan and
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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { STALL_EVENT } from '../src/stall-nudge.ts';
import { DEFAULT_PARALLELISM_CAP, TaskStore, eventsLogPath } from '../src/tasks.ts';

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
      expect(rehydrated.parallelismCap(ws.id)).toMatchObject({ value: 2, isDefault: false });
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
      expect(rehydrated.parallelismCap(ws.id)).toMatchObject({ value: 4, isDefault: true });
    } finally {
      rehydrated.stop();
    }
  });

  // A moved cap must never be a mystery (board row "Agent can see who changed
  // a board's parallelism cap and when"): the record names the actor, the
  // time, and both values, and the event log keeps every change.
  it('records who moved it, when, from what and to what — and the event log keeps every change', async () => {
    const store = new TaskStore({ dataDir, debounceMs: 5 });
    const ws = store.createWorkspace('search-revamp');
    const seen: Array<{ from: number; to: number }> = [];
    store.onEvent((ev) => {
      if (ev.type === 'workspace.parallelism_cap_changed') seen.push(ev);
    });
    const before = Date.now();
    const first = store.setParallelismCap(ws.id, 2, { actor: PERSON });
    expect(first.ok && first.changed).toBe(true);
    const read = store.parallelismCap(ws.id);
    expect(read).toMatchObject({ value: 2, isDefault: false });
    expect(read?.lastChange).toMatchObject({
      actor: { id: PERSON.id, name: PERSON.name, kind: 'person' },
      from: 4,
      to: 2,
    });
    expect(read?.lastChange?.ts).toBeGreaterThanOrEqual(before);

    // Back to the default is a change too — "to" is the effective number,
    // and the reader sees who reset it.
    const second = store.setParallelismCap(ws.id, undefined, { actor: LEAD });
    expect(second.ok && second.changed).toBe(true);
    expect(store.parallelismCap(ws.id)?.lastChange).toMatchObject({
      actor: { id: LEAD.id, name: LEAD.name, kind: 'agent' },
      from: 2,
      to: 4,
    });
    // Both emitted, in order, with both values on each.
    expect(seen.map((e) => [e.from, e.to])).toEqual([
      [4, 2],
      [2, 4],
    ]);
    // Durable: the per-board events log holds BOTH rows — the earlier change
    // is not overwritten by the later one.
    const rows = readFileSync(eventsLogPath(dataDir, ws.id), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row.event === 'workspace.parallelism_cap_changed');
    expect(rows.map((r) => [r.from, r.to])).toEqual([
      [4, 2],
      [2, 4],
    ]);
    expect(rows[0]?.actor).toEqual({ id: PERSON.id, name: PERSON.name, kind: 'person' });
    expect(rows[1]?.actor).toEqual({ id: LEAD.id, name: LEAD.name, kind: 'agent' });

    // The last change survives a reload with the number.
    await settle(60);
    store.stop();
    const rehydrated = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      expect(rehydrated.parallelismCap(ws.id)?.lastChange).toMatchObject({
        actor: { id: LEAD.id },
        from: 2,
        to: 4,
      });
    } finally {
      rehydrated.stop();
    }
  });

  it('a write that leaves the effective cap where it was records nothing', () => {
    const store = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      const ws = store.createWorkspace('search-revamp');
      const seen: unknown[] = [];
      store.onEvent((ev) => {
        if (ev.type === 'workspace.parallelism_cap_changed') seen.push(ev);
      });
      // Explicitly setting the default number, and clearing an unset cap.
      const a = store.setParallelismCap(ws.id, DEFAULT_PARALLELISM_CAP, { actor: PERSON });
      const b = store.setParallelismCap(ws.id, undefined, { actor: PERSON });
      expect(a.ok && a.changed).toBe(false);
      expect(b.ok && b.changed).toBe(false);
      expect(seen).toHaveLength(0);
      expect(store.parallelismCap(ws.id)?.lastChange).toBeUndefined();
    } finally {
      store.stop();
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

  beforeEach(async () => {
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
      await post('/workspaces', { name: 'search-revamp', leadAgentId: LEAD.id }),
    );
    const workspaceId = workspace.id;
    await jj(
      await post(`/workspaces/${workspaceId}/agents`, {
        agentId: LEAD.id,
        runtime: 'claude-code-local',
      }),
    );
    const leadRes = await fetch(
      `${base}/workspaces/${workspaceId}/events:stream?agentId=${encodeURIComponent(LEAD.id)}`,
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
      await post(`/workspaces/${workspaceId}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
      }),
    );
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${task.id}/transition`, {
        to: 'todo',
        author: PERSON,
        workspaceId,
      }),
    );
    if (to === 'in-progress') {
      await jj(
        await post(`/workspaces/${workspaceId}/tasks/${task.id}/transition`, {
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
      const view = await jj<CapView>(await get(`/workspaces/${workspaceId}/parallelism-cap`));
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
          await post(`/workspaces/${workspaceId}/dispatches`, {
            taskId: busy,
            worktreePath: worktree,
            agentName: 'Builder A',
          }),
        );
        const lowered = await jj<CapView>(
          await put(`/workspaces/${workspaceId}/parallelism-cap`, { cap: 1, author: LEAD }),
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
          await put(`/workspaces/${workspaceId}/parallelism-cap`, { cap: null, author: LEAD }),
        );
        expect(restored).toMatchObject({ cap: 4, isDefault: true, inUse: 1, free: 3 });
        // And the settings panel's read agrees.
        const settings = await jj<{
          parallelismCap: {
            value: number;
            isDefault: boolean;
            default: number;
            lastChange?: unknown;
          };
          dispatchesInUse: number;
        }>(await get(`/workspaces/${workspaceId}/settings`));
        expect(settings.parallelismCap).toMatchObject({ value: 4, isDefault: true, default: 4 });
        // The panel's read names who put it back and from what.
        expect(settings.parallelismCap.lastChange).toMatchObject({
          actor: { id: LEAD.id, name: LEAD.name },
          from: 1,
          to: 4,
        });
        expect(settings.dispatchesInUse).toBe(1);
      } finally {
        rmSync(worktree, { recursive: true, force: true });
        await lead.stop();
      }
    });

    it('refuses zero, a fraction, a string, and a missing cap — the floor is one', async () => {
      const { workspaceId, lead } = await boardWithLead();
      for (const body of [{ cap: 0 }, { cap: -1 }, { cap: 1.5 }, { cap: '2' }, {}]) {
        const res = await put(`/workspaces/${workspaceId}/parallelism-cap`, {
          ...body,
          author: LEAD,
        });
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      // Nothing above changed the stored value.
      const view = await jj<CapView>(await get(`/workspaces/${workspaceId}/parallelism-cap`));
      expect(view.cap).toBe(4);
      expect(view.isDefault).toBe(true);
      await lead.stop();
    });

    it('404s a board that does not exist', async () => {
      expect((await get('/workspaces/w-nope/parallelism-cap')).status).toBe(404);
      expect((await put('/workspaces/w-nope/parallelism-cap', { cap: 2 })).status).toBe(404);
    });

    it('the workspace read carries the same numbers, so get_workspace can show them', async () => {
      const { workspaceId, lead } = await boardWithLead();
      await jj(await put(`/workspaces/${workspaceId}/parallelism-cap`, { cap: 2, author: LEAD }));
      const ws = await jj<{ parallelismCap: Record<string, unknown> }>(
        await get(`/workspaces/${workspaceId}?format=json`),
      );
      expect(ws.parallelismCap).toMatchObject({ value: 2, isDefault: false, inUse: 0, free: 2 });
      // And who moved it, when, from what — so a moved cap is never a mystery.
      expect(ws.parallelismCap.lastChange).toMatchObject({
        actor: { id: LEAD.id, name: LEAD.name, kind: 'agent' },
        from: 4,
        to: 2,
      });
      expect(typeof (ws.parallelismCap.lastChange as { ts: unknown }).ts).toBe('number');
      await lead.stop();
    });

    it('a board never asked carries no last change at all', async () => {
      const { workspaceId, lead } = await boardWithLead();
      const ws = await jj<{ parallelismCap: Record<string, unknown> }>(
        await get(`/workspaces/${workspaceId}?format=json`),
      );
      expect(ws.parallelismCap.lastChange).toBeUndefined();
      const view = await jj<CapView & { lastChange?: unknown }>(
        await get(`/workspaces/${workspaceId}/parallelism-cap`),
      );
      expect(view.lastChange).toBeUndefined();
      await lead.stop();
    });

    it('the settings route (the panel’s path) records the same actor the cap route does', async () => {
      const { workspaceId, lead } = await boardWithLead();
      await jj(
        await put(`/workspaces/${workspaceId}/settings`, { author: PERSON, parallelismCap: 3 }),
      );
      const view = await jj<CapView & { lastChange?: Record<string, unknown> }>(
        await get(`/workspaces/${workspaceId}/parallelism-cap`),
      );
      expect(view.lastChange).toMatchObject({
        actor: { id: PERSON.id, name: PERSON.name, kind: 'person' },
        from: 4,
        to: 3,
      });
      // Both routes append to the one log; a second change through the other
      // route does not overwrite the first.
      await jj(await put(`/workspaces/${workspaceId}/parallelism-cap`, { cap: 1, author: LEAD }));
      const rows = readFileSync(eventsLogPath(dataDir, workspaceId), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((row) => row.event === 'workspace.parallelism_cap_changed');
      expect(rows.map((r) => [(r.actor as { id: string }).id, r.from, r.to])).toEqual([
        [PERSON.id, 4, 3],
        [LEAD.id, 3, 1],
      ]);
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
      await jj(await put(`/workspaces/${workspaceId}/parallelism-cap`, { cap: 1, author: LEAD }));

      const next = await jj<NextView>(await get(`/workspaces/${workspaceId}/next`));
      expect(next.tasks.map((t) => t.id)).toEqual([a]);
      expect(next.capacity).toEqual({ cap: 1, inUse: 0, free: 1, heldForCapacity: 2 });
      await lead.stop();
    });

    it('in-progress rows still pass through when every slot is spent — the trim is on offers, not on work in flight', async () => {
      const { workspaceId, lead } = await boardWithLead();
      const busy = await addRow(workspaceId, 'Migrate the search index', 'in-progress');
      await addRow(workspaceId, 'Rank results by recency');
      await jj(await put(`/workspaces/${workspaceId}/parallelism-cap`, { cap: 1, author: LEAD }));
      const worktree = mkdtempSync(join(tmpdir(), 'wt-cap-'));
      try {
        await jj(
          await post(`/workspaces/${workspaceId}/dispatches`, {
            taskId: busy,
            worktreePath: worktree,
          }),
        );
        const next = await jj<NextView>(await get(`/workspaces/${workspaceId}/next`));
        expect(next.tasks.map((t) => t.id)).toEqual([busy]);
        expect(next.capacity).toEqual({ cap: 1, inUse: 1, free: 0, heldForCapacity: 1 });

        // Closing the dispatch frees the slot; the very next read offers the
        // row it was withholding.
        await jj(
          await fetch(`${base}/workspaces/${workspaceId}/dispatches/${encodeURIComponent(busy)}`, {
            method: 'DELETE',
          }),
        );
        const after = await jj<NextView>(await get(`/workspaces/${workspaceId}/next`));
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
      const next = await jj<NextView>(await get(`/workspaces/${workspaceId}/next`));
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
      await jj(await put(`/workspaces/${workspaceId}/parallelism-cap`, { cap: 1, author: LEAD }));

      // A zero window still needs the clock to tick past the last transition.
      await settle(10);
      handle.nudgeStalls();
      const got = await waitForFrames(lead.frames, STALL_EVENT, 1);
      expect(got).toHaveLength(1);
      const frame = got[0]?.data ?? {};
      expect(frame.stalledCount).toBe(1);
      expect((frame.rows as Array<{ id: string }>).map((r) => r.id)).toEqual([top]);
      expect(frame.beyondCapacity).toBe(1);
      // The wake that holds rows for the cap says who set it and when, so
      // the lead is not sent to find out.
      expect(frame.parallelismCap).toMatchObject({
        value: 1,
        lastChange: { actor: { id: LEAD.id, name: LEAD.name }, from: 4, to: 1 },
      });
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
      // Nothing held for the cap, so the frame does not talk about it.
      expect(got[0]?.data?.parallelismCap).toBeUndefined();
      expect(stalls(lead.frames)).toHaveLength(1);
      await lead.stop();
    });
  });
});
