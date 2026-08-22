/**
 * HTTP surface for retiring and renaming a hub board.
 *
 * Every handler under `/api/workspaces` hand-copies body fields into the
 * store call, so a field that isn't copied is silently discarded while the
 * request still returns 200 — the standing reason this file exists at all
 * (see the banner over the hub-board routes in server.ts). Each param below
 * is asserted through the wire, not through the store.
 *
 * The other half is READBACK: retiring is only useful if the surfaces an
 * agent actually calls say so. `GET /api/workspaces/:id`, `/next` and the
 * workspace list are checked here for exactly that, because a retired board
 * that reads as live is the incident with an extra field on it.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';

const AGENT: User = {
  id: 'agent-harbor-relay',
  name: 'Harbor Relay',
  kind: 'known',
  color: '#888888',
};

describe('retire / rename routes', () => {
  let handle: ServerHandle | undefined;
  let dataDir: string | undefined;
  let base = '';

  const start = (): void => {
    dataDir = mkdtempSync(join(tmpdir(), 'ws-retire-routes-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
  };

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const post = (path: string, body?: unknown) => send('POST', path, body);
  const put = (path: string, body?: unknown) => send('PUT', path, body);
  const get = (path: string) => fetch(`${base}${path}`);

  const newBoard = async (name: string): Promise<string> => {
    const r = await post('/api/workspaces', { name, author: AGENT });
    expect(r.status).toBe(200);
    const payload = (await r.json()) as { workspace: { id: string } };
    return payload.workspace.id;
  };

  it('PUT /retired stands a board down and carries the reason through', async () => {
    start();
    const id = await newBoard('harbor-relay');
    const r = await put(`/api/workspaces/${id}/retired`, {
      retired: true,
      reason: 'superseded by the September board',
      author: AGENT,
    });
    expect(r.status).toBe(200);
    const payload = (await r.json()) as {
      changed: boolean;
      workspace: { retiredAt?: number; retiredReason?: string; retiredBy?: { id: string } };
    };
    expect(payload.changed).toBe(true);
    expect(payload.workspace.retiredAt).toBeGreaterThan(0);
    // The `reason` param is the one most likely to be accepted and dropped.
    expect(payload.workspace.retiredReason).toBe('superseded by the September board');
    expect(payload.workspace.retiredBy?.id).toBe(AGENT.id);
  });

  it('PUT /retired with retired:false brings it back', async () => {
    start();
    const id = await newBoard('harbor-relay');
    await put(`/api/workspaces/${id}/retired`, { retired: true, author: AGENT });
    const r = await put(`/api/workspaces/${id}/retired`, { retired: false, author: AGENT });
    expect(r.status).toBe(200);
    const payload = (await r.json()) as { workspace: { retiredAt?: number } };
    expect(payload.workspace.retiredAt).toBeUndefined();
  });

  it('PUT /retired validates its body and its board', async () => {
    start();
    const id = await newBoard('harbor-relay');
    expect((await put(`/api/workspaces/${id}/retired`, { author: AGENT })).status).toBe(400);
    expect(
      (await put(`/api/workspaces/${id}/retired`, { retired: 'yes', author: AGENT })).status,
    ).toBe(400);
    expect((await put(`/api/workspaces/${id}/retired`, { retired: true })).status).toBe(400);
    expect(
      (await put('/api/workspaces/w-not-a-board/retired', { retired: true, author: AGENT })).status,
    ).toBe(404);
  });

  it('POST /rename renames the board and reports the collision it made', async () => {
    start();
    const first = await newBoard('harbor-relay');
    const second = await newBoard('september-board');

    const r = await post(`/api/workspaces/${second}/rename`, {
      name: '  harbor-relay  ',
      author: AGENT,
    });
    expect(r.status).toBe(200);
    const payload = (await r.json()) as {
      changed: boolean;
      workspace: { name: string };
      sameName?: Array<{ workspaceId: string }>;
    };
    expect(payload.changed).toBe(true);
    expect(payload.workspace.name).toBe('harbor-relay');
    expect(payload.sameName?.map((b) => b.workspaceId)).toEqual([first]);
  });

  it('POST /rename refuses an empty name and an unknown board', async () => {
    start();
    const id = await newBoard('harbor-relay');
    expect((await post(`/api/workspaces/${id}/rename`, { name: '  ', author: AGENT })).status).toBe(
      400,
    );
    expect((await post(`/api/workspaces/${id}/rename`, { author: AGENT })).status).toBe(400);
    expect((await post(`/api/workspaces/${id}/rename`, { name: 'ok' })).status).toBe(400);
    expect(
      (await post('/api/workspaces/w-not-a-board/rename', { name: 'ok', author: AGENT })).status,
    ).toBe(404);
  });

  it('GET /api/workspaces/:id says the board is retired, with the notice', async () => {
    start();
    const id = await newBoard('harbor-relay');
    await put(`/api/workspaces/${id}/retired`, {
      retired: true,
      reason: 'superseded',
      author: AGENT,
    });
    const r = await get(`/api/workspaces/${id}`);
    expect(r.status).toBe(200);
    const payload = (await r.json()) as {
      retired?: { since: number; reason?: string; notice: string };
    };
    expect(payload.retired?.reason).toBe('superseded');
    expect(payload.retired?.notice.toLowerCase()).toContain('retired');
  });

  /** The positive control for the assertion above: the field is ABSENT on a
   *  live board, so "no retired key" means live rather than "not implemented". */
  it('GET /api/workspaces/:id carries no retired key on a live board', async () => {
    start();
    const id = await newBoard('harbor-relay');
    const payload = (await (await get(`/api/workspaces/${id}`)).json()) as { retired?: unknown };
    expect(payload.retired).toBeUndefined();
  });

  it('GET /api/workspaces/:id/next warns before an agent picks work off it', async () => {
    start();
    const id = await newBoard('harbor-relay');
    await put(`/api/workspaces/${id}/retired`, { retired: true, author: AGENT });
    const payload = (await (await get(`/api/workspaces/${id}/next`)).json()) as {
      retired?: { notice: string };
    };
    expect(payload.retired?.notice.toLowerCase()).toContain('retired');
  });

  it('GET /api/workspaces marks the retired rows in hubWorkspaces', async () => {
    start();
    const live = await newBoard('harbor-relay');
    const stale = await newBoard('september-board');
    await put(`/api/workspaces/${stale}/retired`, { retired: true, author: AGENT });

    const payload = (await (await get('/api/workspaces')).json()) as {
      hubWorkspaces: Array<{ id: string; retired?: boolean }>;
    };
    const byId = new Map(payload.hubWorkspaces.map((w) => [w.id, w]));
    expect(byId.get(stale)?.retired).toBe(true);
    expect(byId.get(live)?.retired).toBeUndefined();
  });

  /**
   * The workspace list is where the wrong board gets picked, so this is the
   * surface that most has to stop lying. Folded and counted rather than
   * hidden: a retired board is still readable, and a cut list states what it
   * cut.
   */
  it('folds retired boards out of the live list on /, and still links them', async () => {
    start();
    const live = await newBoard('harbor-relay');
    const stale = await newBoard('september-board');
    await put(`/api/workspaces/${stale}/retired`, { retired: true, author: AGENT });

    const html = await (await get('/')).text();
    const foldAt = html.indexOf('Retired workspaces');
    expect(foldAt).toBeGreaterThan(-1);
    // Positive control on the same page: the live board renders ABOVE the
    // fold, so "the retired one is below it" is a placement rather than an
    // artefact of the board being missing entirely.
    const liveAt = html.indexOf(`/workspaces/${live}/home`);
    const staleAt = html.indexOf(`/workspaces/${stale}/home`);
    expect(liveAt).toBeGreaterThan(-1);
    expect(staleAt).toBeGreaterThan(foldAt);
    expect(liveAt).toBeLessThan(foldAt);
  });

  it('refuses a task create on a retired board, on both create doors', async () => {
    start();
    const id = await newBoard('harbor-relay');
    await put(`/api/workspaces/${id}/retired`, {
      retired: true,
      reason: 'superseded',
      author: AGENT,
    });

    const single = await post(`/api/workspaces/${id}/tasks`, {
      title: 'Agent can file work so that the board is current',
      author: AGENT,
      assignee: AGENT.id,
      assigneeKind: 'agent',
    });
    expect(single.status).toBe(409);
    const singleBody = (await single.json()) as { error: string; message?: string };
    expect(singleBody.error).toBe('workspace-retired');
    expect(singleBody.message).toContain('superseded');

    const batch = await post(`/api/workspaces/${id}/tasks/batch`, {
      author: AGENT,
      tasks: [{ title: 'Agent can file work so that the board is current' }],
    });
    expect(batch.status).toBe(409);
    expect(((await batch.json()) as { error: string }).error).toBe('workspace-retired');

    // Nothing landed — the refusal is a refusal, not a warning.
    const tasks = (await (await get(`/api/workspaces/${id}/tasks`)).json()) as {
      tasks: unknown[];
    };
    expect(tasks.tasks).toHaveLength(0);
  });

  it('takes work again once the board is un-retired', async () => {
    start();
    const id = await newBoard('harbor-relay');
    await put(`/api/workspaces/${id}/retired`, { retired: true, author: AGENT });
    await put(`/api/workspaces/${id}/retired`, { retired: false, author: AGENT });
    const r = await post(`/api/workspaces/${id}/tasks`, {
      title: 'Agent can file work so that the board is current',
      author: AGENT,
      assignee: AGENT.id,
      assigneeKind: 'agent',
    });
    expect(r.status).toBe(200);
  });

  it('POST /api/workspaces/:id/attachments hands the lead its duplicate-name warning', async () => {
    start();
    const stale = await newBoard('harbor-relay');
    const live = await newBoard('harbor-relay');
    // Both boards were created by this author, so it holds both lead seats.
    const r = await post(`/api/workspaces/${live}/attachments`, {
      agentId: AGENT.id,
      runtime: 'claude-code-local',
    });
    expect(r.status).toBe(200);
    const payload = (await r.json()) as {
      leadNameConflicts?: { boards: Array<{ workspaceId: string }>; notice: string };
      retired?: unknown;
    };
    expect(payload.leadNameConflicts?.boards.map((b) => b.workspaceId)).toEqual([stale]);
    expect(payload.retired).toBeUndefined();

    // Retiring the stale one is the fix, and the fix has to clear the warning.
    await put(`/api/workspaces/${stale}/retired`, { retired: true, author: AGENT });
    const after = await post(`/api/workspaces/${live}/attachments`, {
      agentId: AGENT.id,
      runtime: 'claude-code-local',
    });
    expect(
      ((await after.json()) as { leadNameConflicts?: unknown }).leadNameConflicts,
    ).toBeUndefined();
  });
});
