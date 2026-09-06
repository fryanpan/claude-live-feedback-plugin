/**
 * The legacy workspace-level TEXT goal is gone, and this file pins what that
 * removal is allowed to cost.
 *
 * Two goal systems disagreed about what a goal is: an ordered goal LIST (the
 * bands the board renders) and a single north-star paragraph on the workspace
 * (`goal` / `goalUpdatedAt`), with its own retriage machinery keyed on the
 * text. The list is the survivor. The paragraph is removed from the data
 * model, the read payloads, and the tool surface.
 *
 * What must NOT break, and is asserted here rather than assumed:
 *
 *  1. `PUT /workspaces/:id/goal` is a SHARED-SERVER route. Old plugin
 *     bundles call it from sessions nobody can restart, so it may not 404 (a
 *     route that vanished) or 500 (a route that broke). It answers 410 with a
 *     body naming the replacement — a deliberate, readable refusal that the
 *     MCP client surfaces verbatim, because a 200 would report success for a
 *     write that did not happen.
 *  2. A legacy `goal` on a create body is ignored, not rejected. Same callers.
 *  3. The stored bytes are SOFT-deleted: a sidecar written before this change
 *     keeps its `goal` text through a hydrate/persist round trip. The sidecar
 *     is the durable record; readers stop reading the field, nothing strips it.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { TaskStore, tasksSidecarPath } from '../src/tasks.ts';
import { seedBoard } from './workspace-seed.ts';

const PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };
const AGENT = { id: 'agent-scout', name: 'Scout', kind: 'agent', color: '#7d2ed7' };

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe('the legacy text goal is removed', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const post = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const put = (path: string, body: unknown) =>
    local(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const newWorkspace = async (extra: Record<string, unknown> = {}): Promise<string> => {
    const r = await post('/workspaces', { name: 'intake', author: AGENT, ...extra });
    const { workspace } = (await r.json()) as { workspace: { id: string } };
    WS = workspace.id;
    return WS;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'textgoal-data-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('the deprecated goal route', () => {
    it('answers 410 — not 404, not 500 — and names what replaced it', async () => {
      const id = await newWorkspace();
      const r = await put(`/workspaces/${id}/goal`, {
        goal: 'Ship the intake queue, then prove it under load.',
        author: PERSON,
      });
      // The three statuses that would be wrong, stated so a regression to any
      // of them reads as the specific failure it is: 404 says the route is
      // gone (an old bundle cannot tell that from a bad workspace id), 500
      // says the server broke, 200 says a write landed that did not.
      expect(r.status).not.toBe(404);
      expect(r.status).not.toBe(500);
      expect(r.status).not.toBe(200);
      expect(r.status).toBe(410);
      const body = (await r.json()) as { error?: string; deprecated?: boolean };
      expect(body.deprecated).toBe(true);
      // The caller is an agent reading this string. It has to say what to do
      // instead, not merely that something is gone.
      expect(body.error).toContain('set_goal_list');
    });

    it('answers 404 for an unknown board — the board question is asked first now', async () => {
      // This used to be a second 410: the route named no board, so a bad
      // workspace id and a good one reached the same tombstone. The board is
      // in the path now and one middleware resolves it above every handler,
      // so an id no board answers to stops there.
      //
      // The 410 above is the control that keeps this honest: the tombstone
      // still answers for a board that EXISTS, so this 404 is the unknown id
      // and not the route having quietly disappeared.
      const r = await put('/workspaces/w-missing/goal', {
        goal: 'anything',
        author: PERSON,
      });
      expect(r.status).toBe(404);
    });

    it('changes nothing on the board', async () => {
      const id = await newWorkspace();
      // The board RECORD, not the page it shares an address with: the shell
      // HTML is the same bytes for every board, so comparing it before and
      // after would pass whatever the write did.
      const before = await (await local(`/workspaces/${id}?format=json`)).text();
      await put(`/workspaces/${id}/goal`, { goal: 'A new north star.', author: PERSON });
      const after = await (await local(`/workspaces/${id}?format=json`)).text();
      expect(after).toBe(before);
    });
  });

  describe('read payloads', () => {
    it('carries no goal, goalUpdatedAt, or pendingRetriage', async () => {
      const id = await newWorkspace();
      const r = await local(`/workspaces/${id}?format=json`);
      expect(r.status).toBe(200);
      const payload = (await r.json()) as {
        workspace: Record<string, unknown>;
        goalSummary?: unknown[];
        pendingRetriage?: unknown;
      };
      expect(payload.workspace).not.toHaveProperty('goal');
      expect(payload.workspace).not.toHaveProperty('goalUpdatedAt');
      expect(payload).not.toHaveProperty('pendingRetriage');
      // Positive control: the surviving goal LIST still rides this payload,
      // so "no goal field" above is a removal rather than a broken read.
      expect(Array.isArray(payload.goalSummary)).toBe(true);
    });

    it('leaves the workspace list without a goal column', async () => {
      await newWorkspace();
      const r = await local('/workspaces');
      const { boardWorkspaces } = (await r.json()) as {
        boardWorkspaces: Array<Record<string, unknown>>;
      };
      expect(boardWorkspaces.length).toBeGreaterThan(0);
      for (const row of boardWorkspaces) {
        expect(row).not.toHaveProperty('goal');
        expect(row).toHaveProperty('name');
      }
    });
  });

  describe('old create payloads', () => {
    it('ignores a legacy goal field rather than refusing the create', async () => {
      const r = await post('/workspaces', {
        name: 'legacy caller',
        goal: 'A north star an old bundle still sends.',
        author: AGENT,
      });
      expect(r.status).toBe(200);
      const { workspace } = (await r.json()) as { workspace: Record<string, unknown> };
      expect(workspace).toHaveProperty('id');
      expect(workspace).not.toHaveProperty('goal');
    });
  });

  describe('placement stamps a goal id, not goal text', () => {
    it('records triagedAgainst with goalId and no text copy', async () => {
      const id = await newWorkspace();
      // Band ids are minted by the store, never chosen by the caller.
      const listed = await put(`/workspaces/${id}/goals`, {
        goals: [{ title: 'Ship it' }],
        author: PERSON,
      });
      expect(listed.status).toBe(200);
      const read = (await (await local(`/workspaces/${id}?format=json`)).json()) as {
        workspace: { goals: Array<{ id: string }> };
      };
      const bandId = read.workspace.goals[0]?.id as string;
      expect(bandId).toBeTruthy();
      const created = await post(`/workspaces/${id}/tasks`, {
        title: 'Wire the intake form',
        body: 'Agent can file intake so that requests stop arriving by mail.',
        author: AGENT,
      });
      const { task } = (await created.json()) as { task: { id: string } };
      const placed = await post(`/workspaces/${WS}/tasks/${task.id}/goal`, {
        goal: bandId,
        author: PERSON,
      });
      expect(placed.status).toBe(200);
      const res = (await placed.json()) as {
        task: { triagedAgainst?: Record<string, unknown> };
      };
      expect(res.task.triagedAgainst?.goalId).toBe(bandId);
      expect(res.task.triagedAgainst).not.toHaveProperty('goal');
    });
  });
});

describe('stored goal text is soft-deleted', () => {
  it('survives a hydrate and re-persist untouched', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'textgoal-soft-'));
    try {
      const legacy = {
        workspace: {
          id: 'w-legacy',
          name: 'legacy board',
          goal: 'The north star an earlier release stored here.',
          goalUpdatedAt: 1_700_000_000_000,
          goalSummary: { text: 'Old short line.', goalHash: 'abc', ts: 1_700_000_000_000 },
          goals: [],
          docIds: [],
          createdAt: 1_700_000_000_000,
        },
        tasks: [],
      };
      // The bytes an earlier release would have left on disk, written before
      // any store reads them.
      mkdirSync(join(dataDir, 'workspaces'), { recursive: true });
      const path = tasksSidecarPath(dataDir, 'w-legacy');
      writeFileSync(path, `${JSON.stringify(legacy, null, 2)}\n`);

      const reborn = new TaskStore({ dataDir, debounceMs: 0 });
      expect(reborn.getWorkspace('w-legacy')).toBeDefined();
      // Force a write of that workspace, which is what would strip the field
      // if the removal had been a hard delete.
      reborn.createTask('w-legacy', {
        title: 'Something to make the store persist',
        body: 'Agent can force a save so that the round trip is real.',
        actor: AGENT,
      });
      reborn.flush();
      const onDisk = JSON.parse(readFileSync(path, 'utf8')) as {
        workspace: Record<string, unknown>;
      };
      expect(onDisk.workspace.goal).toBe('The north star an earlier release stored here.');
      expect(onDisk.workspace.goalUpdatedAt).toBe(1_700_000_000_000);
      expect(onDisk.workspace.goalSummary).toBeDefined();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
