/**
 * A slot under the parallelism cap is an OPEN DISPATCH — and a dispatch on
 * work the board has already finished is not open, whatever the registry
 * file says. Right after deploy v0.1.0-91 the hub read `inUse 12 / free 0`:
 * every holder was a task already `done`, left behind by builders that never
 * sent `close_dispatch`, and the first real spawn would have been refused.
 *
 * Pinned here: a dispatch whose task is done or archived is dropped on read
 * and at boot; one whose worktree directory is gone is dropped; a LIVE one
 * on an open task with a real directory is kept and still counts (the
 * positive control — without it the three drops above would pass against a
 * registry that drops everything); and a task reaching `done` closes its
 * own dispatch without anyone calling `close_dispatch`.
 *
 * Worktrees are real temp directories — the path check is `existsSync`, and
 * a fake would prove nothing about it.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DispatchRegistry } from '../src/dispatch-registry.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

interface CapView {
  cap: number;
  inUse: number;
  free: number;
  holders: Array<{ taskId: string; title?: string; agentName?: string }>;
}

describe('the registry drops a dispatch the board is done with', () => {
  let dataDir: string;
  const dirs: string[] = [];
  const dir = (prefix: string) => {
    const d = tempDir(prefix);
    dirs.push(d);
    return d;
  };

  beforeEach(() => {
    dataDir = dir('dispatch-stale-reg-');
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('a live dispatch on an open task with an existing worktree is kept — the positive control', () => {
    const worktree = dir('wt-live-');
    const reg = new DispatchRegistry({
      dataDir,
      watchFactory: () => ({ close: () => {} }),
      isTaskOver: () => false,
    });
    try {
      expect(reg.register('t-live', worktree, 'Builder A').ok).toBe(true);
      expect(reg.prune()).toEqual([]);
      expect(reg.list().map((d) => d.taskId)).toEqual(['t-live']);
      expect(reg.activityFor('t-live')).toBeUndefined(); // no event yet, still open
      expect(reg.list().map((d) => d.taskId)).toEqual(['t-live']);
    } finally {
      reg.stop();
    }
  });

  it('a dispatch whose task the board finished is closed on read, and the closure persists', () => {
    const worktree = dir('wt-done-');
    const over = new Set<string>();
    const reg = new DispatchRegistry({
      dataDir,
      watchFactory: () => ({ close: () => {} }),
      isTaskOver: (id) => over.has(id),
    });
    try {
      expect(reg.register('t-done', worktree, 'Builder A').ok).toBe(true);
      expect(reg.register('t-open', worktree, 'Builder B').ok).toBe(true);
      // The directory is still on disk — exactly the shape the hub had.
      over.add('t-done');
      expect(existsSync(worktree)).toBe(true);
      expect(reg.list().map((d) => d.taskId)).toEqual(['t-open']);
      expect(reg.activityFor('t-done')).toBeUndefined();
      const persisted = JSON.parse(readFileSync(join(dataDir, 'dispatches.json'), 'utf8'));
      expect(Object.keys(persisted.dispatches)).toEqual(['t-open']);
    } finally {
      reg.stop();
    }
  });

  it('a dispatch whose worktree directory is gone is closed on read', () => {
    const gone = dir('wt-gone-');
    const kept = dir('wt-kept-');
    const reg = new DispatchRegistry({
      dataDir,
      watchFactory: () => ({ close: () => {} }),
      isTaskOver: () => false,
    });
    try {
      expect(reg.register('t-gone', gone, 'Builder A').ok).toBe(true);
      expect(reg.register('t-kept', kept, 'Builder B').ok).toBe(true);
      rmSync(gone, { recursive: true, force: true });
      expect(reg.list().map((d) => d.taskId)).toEqual(['t-kept']);
    } finally {
      reg.stop();
    }
  });

  it('at boot, a persisted dispatch on a finished task is closed before anything reads it', () => {
    const worktree = dir('wt-boot-');
    writeFileSync(
      join(dataDir, 'dispatches.json'),
      JSON.stringify({
        version: 1,
        dispatches: {
          't-finished': { worktreePath: worktree, registeredAt: 1 },
          't-vanished': { worktreePath: join(worktree, 'never-made'), registeredAt: 2 },
          't-live': { worktreePath: worktree, registeredAt: 3, agentName: 'Builder C' },
        },
      }),
    );
    const armed: string[] = [];
    const reg = new DispatchRegistry({
      dataDir,
      watchFactory: (path) => {
        armed.push(path);
        return { close: () => {} };
      },
      isTaskOver: (id) => id === 't-finished',
    });
    try {
      expect(reg.prunedAtBoot).toEqual(['t-finished', 't-vanished']);
      expect(reg.list().map((d) => d.taskId)).toEqual(['t-live']);
      // Only the live one ever armed a watcher.
      expect(armed).toEqual([worktree]);
      const persisted = JSON.parse(readFileSync(join(dataDir, 'dispatches.json'), 'utf8'));
      expect(Object.keys(persisted.dispatches)).toEqual(['t-live']);
    } finally {
      reg.stop();
    }
  });
});

describe('the cap through the server never counts finished work', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  const dirs: string[] = [];
  const dir = (prefix: string) => {
    const d = tempDir(prefix);
    dirs.push(d);
    return d;
  };

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (path: string) => fetch(`${base}${path}`);
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  const start = () => {
    handle = createServer({
      port: 0,
      dataDir,
      dispatchWatchFactory: () => ({ close: () => {} }),
    });
    base = `http://localhost:${handle.port}`;
  };

  beforeEach(() => {
    dataDir = dir('dispatch-stale-srv-');
    start();
  });

  afterEach(async () => {
    await handle.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function board(): Promise<string> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', leadAgentId: LEAD.id }),
    );
    return workspace.id;
  }

  async function addRow(workspaceId: string, title: string): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
      }),
    );
    for (const to of ['todo', 'in-progress'] as const) {
      await jj(
        await post(`/api/tasks/${task.id}/transition`, {
          to,
          author: to === 'todo' ? PERSON : LEAD,
          workspaceId,
        }),
      );
    }
    return task.id;
  }

  const capView = async (workspaceId: string) =>
    jj<CapView>(await get(`/api/workspaces/${workspaceId}/parallelism-cap`));

  it('a task reaching done closes its own dispatch — no close_dispatch needed', async () => {
    const workspaceId = await board();
    const finishing = await addRow(workspaceId, 'Migrate the search index');
    const staying = await addRow(workspaceId, 'Rebuild the ranker');
    const wtA = dir('wt-a-');
    const wtB = dir('wt-b-');
    await jj(
      await post('/api/dispatches', { taskId: finishing, worktreePath: wtA, agentName: 'A' }),
    );
    await jj(await post('/api/dispatches', { taskId: staying, worktreePath: wtB, agentName: 'B' }));
    expect(await capView(workspaceId)).toMatchObject({ inUse: 2, free: 2 });

    await jj(
      await post(`/api/tasks/${finishing}/transition`, { to: 'done', author: LEAD, workspaceId }),
    );
    // The directory is still there; only the board's verdict changed.
    expect(existsSync(wtA)).toBe(true);
    const view = await capView(workspaceId);
    expect(view).toMatchObject({ inUse: 1, free: 3 });
    expect(view.holders.map((h) => h.taskId)).toEqual([staying]);
    const { dispatches } = await jj<{ dispatches: Array<{ taskId: string }> }>(
      await get('/api/dispatches'),
    );
    expect(dispatches.map((d) => d.taskId)).toEqual([staying]);
  });

  it('archiving a task closes its dispatch too', async () => {
    const workspaceId = await board();
    const archived = await addRow(workspaceId, 'Migrate the search index');
    const wt = dir('wt-arch-');
    await jj(await post('/api/dispatches', { taskId: archived, worktreePath: wt, agentName: 'A' }));
    expect(await capView(workspaceId)).toMatchObject({ inUse: 1 });
    await jj(
      await post(`/api/tasks/${archived}/archive`, { author: PERSON, reason: 'superseded' }),
    );
    const view = await capView(workspaceId);
    expect(view).toMatchObject({ inUse: 0, free: 4, holders: [] });
  });

  it('a stale file from before a restart — done tasks holding every slot — reads as free at boot', async () => {
    const workspaceId = await board();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await addRow(workspaceId, `Finished row ${i}`));
    const live = await addRow(workspaceId, 'Rebuild the ranker');
    const wt = dir('wt-restart-');
    // Finish the four the way the hub's were finished: done on the board,
    // directory still on disk, `close_dispatch` never sent.
    for (const id of ids) {
      await jj(
        await post(`/api/tasks/${id}/transition`, { to: 'done', author: LEAD, workspaceId }),
      );
    }
    await settle(80);
    await handle.stop();
    // Write the registry file the deploy found: every done row a holder.
    const dispatches: Record<string, { worktreePath: string; registeredAt: number }> = {};
    for (const id of ids) dispatches[id] = { worktreePath: wt, registeredAt: 1 };
    dispatches[live] = { worktreePath: wt, registeredAt: 2 };
    writeFileSync(join(dataDir, 'dispatches.json'), JSON.stringify({ version: 1, dispatches }));

    start();
    const view = await capView(workspaceId);
    expect(view).toMatchObject({ cap: 4, inUse: 1, free: 3 });
    expect(view.holders.map((h) => h.taskId)).toEqual([live]);
    // And a fresh spawn is not refused for slots nobody holds.
    const next = await addRow(workspaceId, 'Ship the new ranker');
    const wt2 = dir('wt-next-');
    const res = await post('/api/dispatches', { taskId: next, worktreePath: wt2, agentName: 'B' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await capView(workspaceId)).toMatchObject({ inUse: 2, free: 2 });
  });
});
