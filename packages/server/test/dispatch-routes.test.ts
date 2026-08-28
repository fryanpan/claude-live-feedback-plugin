/**
 * The dispatch registry through the server: the REST surface the lead calls,
 * and the stall pass reading worktree activity as the row moving.
 *
 * The watcher is the injected fake — CI runs Bun on Linux, where a real
 * recursive watch drops events by design (dispatch-registry.test.ts has the
 * darwin-gated real one). What this file pins is the wiring: a registered
 * dispatch whose worktree just moved keeps its row out of the wake, and one
 * whose worktree is silent does not — the pair, because the silent case is
 * the positive control proving the quiet window and the frame plumbing can
 * fire at all in this harness.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchRecord } from '../src/dispatch-registry.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { STALL_EVENT } from '../src/stall-nudge.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

/** Rows must out-quiet this window before the fake activity can matter. */
const QUIET_MS = 250;

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

describe('builder dispatches through the server', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  /** The fake watcher's handles, keyed by watched path. */
  let fired: Map<string, () => void>;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'dispatch-routes-'));
    fired = new Map();
    handle = createServer({
      port: 0,
      dataDir,
      stallNudgeQuietMs: QUIET_MS,
      dispatchWatchFactory: (path, onEvent) => {
        fired.set(path, onEvent);
        return { close: () => fired.delete(path) };
      },
    });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function boardWithLead(): Promise<{
    workspaceId: string;
    lead: ReturnType<typeof listenFrames>;
  }> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', leadAgentId: LEAD.id }),
    );
    await jj(
      await post(`/api/workspaces/${workspace.id}/attachments`, {
        agentId: LEAD.id,
        runtime: 'claude-code-local',
      }),
    );
    const leadRes = await fetch(
      `${base}/events/workspace/${workspace.id}?agentId=${encodeURIComponent(LEAD.id)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    return { workspaceId: workspace.id, lead: listenFrames(leadRes) };
  }

  async function inProgressRow(workspaceId: string, title: string): Promise<string> {
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
    await jj(
      await post(`/api/tasks/${task.id}/transition`, {
        to: 'in-progress',
        author: LEAD,
        workspaceId,
      }),
    );
    return task.id;
  }

  const stalls = (frames: Frame[]) => frames.filter((f) => f.event === STALL_EVENT);

  it('register, list, close over REST', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'wt-'));
    try {
      const reg = await jj<{ ok: boolean; dispatch: DispatchRecord }>(
        await post('/api/dispatches', { taskId: 't-alpha', worktreePath: worktree }),
      );
      expect(reg.dispatch.taskId).toBe('t-alpha');
      expect(reg.dispatch.watching).toBe(true);

      const listed = await jj<{ dispatches: DispatchRecord[] }>(
        await fetch(`${base}/api/dispatches`),
      );
      expect(listed.dispatches.map((d) => d.taskId)).toEqual(['t-alpha']);

      const closed = await jj<{ closed: boolean }>(
        await fetch(`${base}/api/dispatches/t-alpha`, { method: 'DELETE' }),
      );
      expect(closed.closed).toBe(true);
      const again = await jj<{ closed: boolean }>(
        await fetch(`${base}/api/dispatches/t-alpha`, { method: 'DELETE' }),
      );
      expect(again.closed).toBe(false);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('refuses bad registrations with the registry’s own words', async () => {
    const missing = await post('/api/dispatches', {
      taskId: 't-alpha',
      worktreePath: join(tmpdir(), 'no-such-worktree-here'),
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe('no-such-path');

    const relative = await post('/api/dispatches', { taskId: 't-alpha', worktreePath: 'rel/x' });
    expect(relative.status).toBe(400);

    const badId = await post('/api/dispatches', { taskId: 'has spaces', worktreePath: tmpdir() });
    expect(badId.status).toBe(400);

    const noBody = await post('/api/dispatches', {});
    expect(noBody.status).toBe(400);
  });

  it('a silent worktree does not excuse its row — the wake still fires', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'wt-'));
    try {
      const ctx = await boardWithLead();
      const taskId = await inProgressRow(ctx.workspaceId, 'Rank results by recency');
      await jj(await post('/api/dispatches', { taskId, worktreePath: worktree }));
      // Out-quiet the window with no watcher events at all.
      await settle(QUIET_MS + 150);

      handle.nudgeStalls();
      const got = await waitForFrames(ctx.lead.frames, STALL_EVENT, 1);
      expect(got).toHaveLength(1);
      expect(got[0]?.data?.taskId).toBe(taskId);
      await ctx.lead.stop();
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('fresh worktree activity keeps the row out of the wake', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'wt-'));
    try {
      const ctx = await boardWithLead();
      const taskId = await inProgressRow(ctx.workspaceId, 'Rank results by recency');
      await jj(await post('/api/dispatches', { taskId, worktreePath: worktree }));
      await settle(QUIET_MS + 150);
      // The builder just touched a file: the watcher speaks, the board stays
      // silent — exactly the false-positive shape.
      fired.get(worktree)?.();

      handle.nudgeStalls();
      // The silent-worktree test above is the positive control: same board,
      // same window, same harness, frame observed. Here the same wait must
      // produce none.
      await settle(300);
      expect(stalls(ctx.lead.frames)).toHaveLength(0);
      await ctx.lead.stop();
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('closing the dispatch withdraws the exoneration', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'wt-'));
    try {
      const ctx = await boardWithLead();
      const taskId = await inProgressRow(ctx.workspaceId, 'Rank results by recency');
      await jj(await post('/api/dispatches', { taskId, worktreePath: worktree }));
      await settle(QUIET_MS + 150);
      fired.get(worktree)?.();
      await jj(
        await fetch(`${base}/api/dispatches/${encodeURIComponent(taskId)}`, { method: 'DELETE' }),
      );

      handle.nudgeStalls();
      const got = await waitForFrames(ctx.lead.frames, STALL_EVENT, 1);
      expect(got).toHaveLength(1);
      expect(got[0]?.data?.taskId).toBe(taskId);
      await ctx.lead.stop();
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});
